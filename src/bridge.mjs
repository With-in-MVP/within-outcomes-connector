// Within Privacy Bridge
//
// Runs inside the VENDOR's environment. Pulls outcome records from the vendor's
// CRM or database, pseudonymizes the user identifier locally, discards all raw
// fields, and pushes outcome events to Within's ingestion API. Raw data never
// leaves the environment this process runs in.
//
// Adapters (selected via CRM env var):
//   salesforce (default) — zero-dependency, Connected App + SOQL
//   postgres             — the bridge's one dependency (`pg`), for billing
//                          tables / sanitized views in the vendor's own DB
//
// Stateless and idempotent: each run re-reads a trailing window and re-pushes;
// Within's API deduplicates per subject per day. No local state, no database.
//
// Usage:  node src/bridge.mjs [--dry-run]
// Config: environment variables — see .env.example

import { readFileSync } from 'node:fs';
import { salesforceConfig, salesforceRows } from './adapters/salesforce.mjs';
import { postgresConfig, postgresRows } from './adapters/postgres.mjs';
import { ID_NORMALIZE_MODES, toOutcomeEvent, buildConversionPayload, buildOutcomeItem } from './lib.mjs';

const VERSION = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;

// ── configuration ─────────────────────────────────────────────────────────

const env = (name, fallback) => {
    const v = process.env[name] ?? fallback;
    if (v === undefined) throw new Error(`missing required env var: ${name}`);
    return v;
};

const CRM = (process.env.CRM ?? 'salesforce').toLowerCase();

const CONFIG = {
    outcomeMap: JSON.parse(env('OUTCOME_MAP', '{"converted":"conversion","upgraded":"conversion","churned":"churn"}')),
    // Same default the SDK bakes in; override only for testing or a
    // dedicated/on-prem Within deployment. Empty counts as unset.
    withinBaseUrl: (process.env.WITHIN_INGEST_BASE_URL || 'https://api.getwith.in').replace(/\/+$/, ''),
    vendorSlug: env('WITHIN_VENDOR_SLUG'),
    ingestKey: env('WITHIN_INGEST_KEY'),
    // v2 — vendor-held HMAC secret; requires matching SDK support. Leave unset.
    hashSecret: process.env.HASH_SECRET || null,
    lookbackDays: Number(env('LOOKBACK_DAYS', '7')),
    // Must mirror what the vendor's identify() does to the same identifier
    // before the SDK hashes it: 'lowercase' (default; emails) or 'none'
    // (case-sensitive account IDs — the SDK itself never lowercases).
    idNormalize: env('ID_NORMALIZE', 'lowercase').toLowerCase(),
    // Churn ingestion via the CRM outcomes API. source identifies the system
    // of record in the request envelope; source_mapping names where in it the
    // outcome lives (letters, digits, dots, underscores, dashes).
    outcomesPath: env('OUTCOMES_PATH', '/api/crm/outcomes'),
    outcomeSource: env('OUTCOME_SOURCE', CRM),
    outcomeSourceMapping: env('OUTCOME_SOURCE_MAPPING', CRM),
};
if (!ID_NORMALIZE_MODES.includes(CONFIG.idNormalize)) {
    throw new Error(`invalid ID_NORMALIZE: ${CONFIG.idNormalize} (supported: ${ID_NORMALIZE_MODES.join(', ')})`);
}

const ADAPTERS = {
    salesforce: () => {
        const cfg = salesforceConfig(process.env);
        return salesforceRows(cfg, CONFIG.lookbackDays);
    },
    postgres: () => {
        const cfg = postgresConfig(process.env);
        return postgresRows(cfg, CONFIG.lookbackDays);
    },
};
if (!ADAPTERS[CRM]) throw new Error(`unknown CRM adapter: ${CRM} (supported: ${Object.keys(ADAPTERS).join(', ')})`);

const DRY_RUN = process.argv.includes('--dry-run');

// ── load: push through Within's ingestion API ─────────────────────────────
// (pseudonymization + transform live in lib.mjs — the privacy boundary)

async function pushConversion(evt) {
    const res = await fetch(`${CONFIG.withinBaseUrl}/api/sdk/conversions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${CONFIG.ingestKey}` },
        body: JSON.stringify(buildConversionPayload(evt, CONFIG)),
    });
    const body = await res.json().catch(() => ({}));
    return { ok: res.ok, status: res.status, inserted: body.inserted ?? null, body };
}

// Push queued churn (and other non-conversion) outcomes in batches of ≤100
// through the CRM outcomes API. Deduplication is server-side via the
// deterministic idempotency_key on each item.
async function pushOutcomeBatch(items) {
    const res = await fetch(`${CONFIG.withinBaseUrl}${CONFIG.outcomesPath}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${CONFIG.ingestKey}` },
        body: JSON.stringify({ vendor_slug: CONFIG.vendorSlug, source: CONFIG.outcomeSource, outcomes: items }),
    });
    const body = await res.json().catch(() => ({}));
    return { ok: res.ok, status: res.status, results: Array.isArray(body.results) ? body.results : [], body };
}

async function flushOutcomes(queue, stats) {
    for (let i = 0; i < queue.length; i += 100) {
        const batch = queue.slice(i, i + 100);
        const result = await pushOutcomeBatch(batch);
        if (result.status === 404) {
            // Outcomes endpoint not deployed on this ingest host yet — don't
            // fail the whole run; conversions still flowed.
            stats.churn_skipped += queue.length - i;
            console.error(`outcomes endpoint ${CONFIG.outcomesPath} not available (404) — `
                + `${queue.length - i} churn outcome(s) skipped; they will be retried next run`);
            return;
        }
        if (!result.ok) {
            stats.churn_failed += batch.length;
            console.error(`FAILED outcomes batch | HTTP ${result.status} | ${JSON.stringify(result.body).slice(0, 200)}`);
            continue;
        }
        for (const r of result.results) {
            if (r?.status === 'rejected') {
                stats.churn_failed++;
                console.error(`REJECTED outcome ${String(r.idempotency_key).slice(0, 12)}… | ${r.error}`);
            } else if (r?.inserted === false) {
                stats.churn_deduped++;
            } else {
                stats.churn_pushed++;
            }
        }
    }
}

async function postHeartbeat(stats) {
    try {
        await fetch(`${CONFIG.withinBaseUrl}/api/sdk/events`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${CONFIG.ingestKey}` },
            body: JSON.stringify({
                vendor_slug: CONFIG.vendorSlug,
                sdk_version: `privacy-bridge/${VERSION}`,
                events: [{
                    eventType: 'within:custom',
                    resourceName: 'privacy_bridge_heartbeat',
                    sessionId: `ses_bridge_${new Date().toISOString().slice(0, 10)}`,
                    timestamp: new Date().toISOString(),
                    properties: { adapter: CRM, ...stats },
                }],
            }),
        });
    } catch (err) {
        console.error(`heartbeat failed (non-fatal): ${err.message}`);
    }
}

// ── main ──────────────────────────────────────────────────────────────────

const stats = {
    scanned: 0, pushed: 0, deduped: 0, failed: 0,
    churn_pushed: 0, churn_deduped: 0, churn_failed: 0, churn_skipped: 0,
    unmapped_skipped: 0,
};
const startedAt = Date.now();
const runStartedAt = new Date().toISOString();
const churnQueue = [];

for await (const row of ADAPTERS[CRM]()) {
    stats.scanned++;
    if (row.rawId == null || row.rawId === '') { stats.unmapped_skipped++; continue; }
    const evt = toOutcomeEvent(row, CONFIG);

    if (evt.kind === 'churn') {
        if (DRY_RUN) { stats.churn_pushed++; console.log(`[dry-run] churn ${evt.subject.slice(0, 12)}… (${evt.outcome})`); continue; }
        churnQueue.push(buildOutcomeItem(evt, CONFIG, runStartedAt));
        continue;
    }
    if (evt.kind !== 'conversion') { stats.unmapped_skipped++; continue; }

    if (DRY_RUN) { stats.pushed++; console.log(`[dry-run] conversion ${evt.subject.slice(0, 12)}… (${evt.outcome})`); continue; }

    const result = await pushConversion(evt);
    if (result.ok) {
        result.inserted === false ? stats.deduped++ : stats.pushed++;
        console.log(`pushed ${evt.outcome} | ${evt.subject.slice(0, 12)}… | inserted=${result.inserted}`);
    } else {
        stats.failed++;
        console.error(`FAILED ${evt.subject.slice(0, 12)}… | HTTP ${result.status} | ${JSON.stringify(result.body).slice(0, 200)}`);
    }
}

if (churnQueue.length > 0) await flushOutcomes(churnQueue, stats);

stats.duration_ms = Date.now() - startedAt;
console.log(`bridge run complete [${CRM}]: ${JSON.stringify(stats)}`);
if (!DRY_RUN) await postHeartbeat(stats);
if (stats.failed > 0 || stats.churn_failed > 0) process.exit(1);
