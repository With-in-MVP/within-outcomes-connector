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
// Config: environment variables — see config.example.env

import { createHash, createHmac } from 'node:crypto';
import { salesforceConfig, salesforceRows } from './adapters/salesforce.mjs';
import { postgresConfig, postgresRows } from './adapters/postgres.mjs';

// ── configuration ─────────────────────────────────────────────────────────

const env = (name, fallback) => {
    const v = process.env[name] ?? fallback;
    if (v === undefined) throw new Error(`missing required env var: ${name}`);
    return v;
};

const CRM = (process.env.CRM ?? 'salesforce').toLowerCase();

const CONFIG = {
    outcomeMap: JSON.parse(env('OUTCOME_MAP', '{"converted":"conversion","upgraded":"conversion","churned":"churn"}')),
    withinBaseUrl: env('WITHIN_INGEST_BASE_URL').replace(/\/+$/, ''),
    vendorSlug: env('WITHIN_VENDOR_SLUG'),
    ingestKey: env('WITHIN_INGEST_KEY'),
    // v2 — vendor-held HMAC secret; requires matching SDK support. Leave unset.
    hashSecret: process.env.HASH_SECRET || null,
    lookbackDays: Number(env('LOOKBACK_DAYS', '7')),
};

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

// ── pseudonymization (identical construction to the Within SDK) ───────────

function hashSubject(vendorSlug, subject, secret = null) {
    const message = `subject:${vendorSlug.trim().toLowerCase()}:${subject.trim()}`;
    return secret
        ? createHmac('sha256', secret).update(message).digest('hex')
        : createHash('sha256').update(message).digest('hex');
}

// ── transform: the privacy boundary. Raw identifiers do not survive this. ─

function toOutcomeEvent(row) {
    const outcomeValue = String(row.outcome ?? '').toLowerCase();
    return {
        kind: CONFIG.outcomeMap[outcomeValue] ?? 'skip',
        subject: hashSubject(CONFIG.vendorSlug, String(row.rawId).toLowerCase(), CONFIG.hashSecret),
        outcome: outcomeValue,
        outcome_at: row.outcomeAt ?? null,
        plan: row.plan ?? null,
    };
}

// ── load: push through Within's ingestion API ─────────────────────────────

async function pushConversion(evt) {
    const res = await fetch(`${CONFIG.withinBaseUrl}/api/sdk/conversions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${CONFIG.ingestKey}` },
        body: JSON.stringify({
            vendor_slug: CONFIG.vendorSlug,
            subject: evt.subject,
            converted_at: evt.outcome_at ? `${evt.outcome_at}T00:00:00.000Z` : undefined,
            conversion_utc_date: evt.outcome_at ?? undefined,
            plan: evt.plan ? { id: evt.plan, name: evt.plan } : undefined,
            metadata: { source: 'within-privacy-bridge', outcome: evt.outcome },
        }),
    });
    const body = await res.json().catch(() => ({}));
    return { ok: res.ok, status: res.status, inserted: body.inserted ?? null, body };
}

async function postHeartbeat(stats) {
    try {
        await fetch(`${CONFIG.withinBaseUrl}/api/sdk/events`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${CONFIG.ingestKey}` },
            body: JSON.stringify({
                vendor_slug: CONFIG.vendorSlug,
                sdk_version: 'privacy-bridge/1.1.0',
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

const stats = { scanned: 0, pushed: 0, deduped: 0, failed: 0, churn_skipped: 0, unmapped_skipped: 0 };
const startedAt = Date.now();

for await (const row of ADAPTERS[CRM]()) {
    stats.scanned++;
    if (row.rawId == null || row.rawId === '') { stats.unmapped_skipped++; continue; }
    const evt = toOutcomeEvent(row);

    if (evt.kind === 'churn') { stats.churn_skipped++; continue; }     // pending churn ingestion
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

stats.duration_ms = Date.now() - startedAt;
console.log(`bridge run complete [${CRM}]: ${JSON.stringify(stats)}`);
if (!DRY_RUN) await postHeartbeat(stats);
if (stats.failed > 0) process.exit(1);
