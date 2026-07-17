// Within Privacy Bridge v1
//
// Runs inside the VENDOR's environment. Pulls outcome records from the vendor's
// CRM, pseudonymizes the user identifier locally, discards all raw fields, and
// pushes outcome events to Within's ingestion API. Raw CRM data never leaves
// the environment this process runs in.
//
// Zero dependencies: only Node.js built-ins (fetch, crypto). Every line that
// touches CRM data is in this file.
//
// Designed to be stateless and idempotent: each run re-reads a trailing window
// of recently-modified records and re-pushes them; Within's ingestion API
// deduplicates per subject per day, so overlapping runs are harmless. There is
// no local state, no database, and nothing persisted between runs.
//
// Usage:  node src/bridge.mjs [--dry-run]
// Config: entirely via environment variables — see config.example.env

import { createHash, createHmac } from 'node:crypto';

// ── configuration ─────────────────────────────────────────────────────────

const env = (name, fallback) => {
    const v = process.env[name] ?? fallback;
    if (v === undefined) throw new Error(`missing required env var: ${name}`);
    return v;
};

const CONFIG = {
    // CRM connection (Salesforce adapter)
    sfInstanceUrl: env('SF_INSTANCE_URL').replace(/\/+$/, ''),
    sfClientId: env('SF_CLIENT_ID'),
    sfClientSecret: env('SF_CLIENT_SECRET'),

    // CRM field mapping — adapt to your org's schema
    sfObject: env('SF_OBJECT', 'Contact'),
    idField: env('SF_ID_FIELD', 'Email'),                       // the shared identifier (must equal what identify() returns)
    outcomeField: env('SF_OUTCOME_FIELD'),                      // e.g. Outcome__c
    outcomeDateField: env('SF_OUTCOME_DATE_FIELD'),             // e.g. Outcome_At__c
    planField: process.env.SF_PLAN_FIELD || null,               // optional

    // Which outcome values map to a Within outcome. Anything unmapped is skipped.
    // v1 supports "conversion" only; "churn" mappings are counted and skipped
    // until Within ships churn ingestion.
    outcomeMap: JSON.parse(env('OUTCOME_MAP', '{"converted":"conversion","upgraded":"conversion","churned":"churn"}')),

    // Within ingestion
    withinBaseUrl: env('WITHIN_INGEST_BASE_URL').replace(/\/+$/, ''),
    vendorSlug: env('WITHIN_VENDOR_SLUG'),
    ingestKey: env('WITHIN_INGEST_KEY'),

    // Pseudonymization. HASH_SECRET is v2 (requires SDK-side support so usage
    // and outcome hashes match) — leave unset unless your Within SDK version
    // documents supporting it.
    hashSecret: process.env.HASH_SECRET || null,

    // Idempotent trailing window: re-read anything modified in the last N days.
    lookbackDays: Number(env('LOOKBACK_DAYS', '7')),
};

const DRY_RUN = process.argv.includes('--dry-run');

// ── pseudonymization (identical construction to the Within SDK) ───────────

function hashSubject(vendorSlug, subject, secret = null) {
    const message = `subject:${vendorSlug.trim().toLowerCase()}:${subject.trim()}`;
    return secret
        ? createHmac('sha256', secret).update(message).digest('hex')
        : createHash('sha256').update(message).digest('hex');
}

function normalizeIdentifier(raw) {
    return String(raw).trim().toLowerCase();
}

// ── CRM adapter: Salesforce ───────────────────────────────────────────────

async function salesforceToken() {
    const res = await fetch(`${CONFIG.sfInstanceUrl}/services/oauth2/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
            grant_type: 'client_credentials',
            client_id: CONFIG.sfClientId,
            client_secret: CONFIG.sfClientSecret,
        }),
    });
    const body = await res.json();
    if (!body.access_token) throw new Error(`salesforce auth failed: ${JSON.stringify(body)}`);
    return body.access_token;
}

async function* salesforceRecords(token) {
    const fields = [CONFIG.idField, CONFIG.outcomeField, CONFIG.outcomeDateField, CONFIG.planField]
        .filter(Boolean).join(', ');
    const since = new Date(Date.now() - CONFIG.lookbackDays * 86_400_000).toISOString();
    const soql = `SELECT ${fields} FROM ${CONFIG.sfObject} `
        + `WHERE ${CONFIG.idField} != null AND ${CONFIG.outcomeField} != null `
        + `AND LastModifiedDate >= ${since}`;

    let url = `${CONFIG.sfInstanceUrl}/services/data/v61.0/query?q=${encodeURIComponent(soql)}`;
    while (url) {
        const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
        const body = await res.json();
        if (!body.records) throw new Error(`salesforce query failed: ${JSON.stringify(body).slice(0, 300)}`);
        yield* body.records;
        url = body.nextRecordsUrl ? `${CONFIG.sfInstanceUrl}${body.nextRecordsUrl}` : null;
    }
}

// ── transform: the privacy boundary ───────────────────────────────────────
// Raw identifiers do not survive this function.

function toOutcomeEvent(record) {
    const rawId = record[CONFIG.idField];
    const outcomeValue = String(record[CONFIG.outcomeField] ?? '').toLowerCase();
    const kind = CONFIG.outcomeMap[outcomeValue] ?? 'skip';
    const date = record[CONFIG.outcomeDateField] ?? null;
    return {
        kind,                                                            // 'conversion' | 'churn' | 'skip'
        subject_hash: hashSubject(CONFIG.vendorSlug, normalizeIdentifier(rawId), CONFIG.hashSecret),
        outcome: outcomeValue,
        outcome_at: date,
        plan: CONFIG.planField ? (record[CONFIG.planField] ?? null) : null,
    };
}

// ── load: push through Within's ingestion API ─────────────────────────────

async function pushConversion(evt) {
    const res = await fetch(`${CONFIG.withinBaseUrl}/api/sdk/conversions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${CONFIG.ingestKey}` },
        body: JSON.stringify({
            vendor_slug: CONFIG.vendorSlug,
            subject: evt.subject_hash,
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
    // Emitted as a diagnostic event so Within (and the vendor's dashboard) can
    // see the bridge is alive and when it last synced. Contains counts only.
    try {
        await fetch(`${CONFIG.withinBaseUrl}/api/sdk/events`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${CONFIG.ingestKey}` },
            body: JSON.stringify({
                vendor_slug: CONFIG.vendorSlug,
                sdk_version: 'privacy-bridge/1.0.0',
                events: [{
                    eventType: 'within:custom',
                    resourceName: 'privacy_bridge_heartbeat',
                    sessionId: `ses_bridge_${new Date().toISOString().slice(0, 10)}`,
                    timestamp: new Date().toISOString(),
                    properties: stats,
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

const token = await salesforceToken();
for await (const record of salesforceRecords(token)) {
    stats.scanned++;
    const evt = toOutcomeEvent(record);

    if (evt.kind === 'churn') { stats.churn_skipped++; continue; }     // v2: churn ingestion
    if (evt.kind !== 'conversion') { stats.unmapped_skipped++; continue; }

    if (DRY_RUN) { stats.pushed++; console.log(`[dry-run] conversion ${evt.subject_hash.slice(0, 12)}… (${evt.outcome})`); continue; }

    const result = await pushConversion(evt);
    if (result.ok) {
        result.inserted === false ? stats.deduped++ : stats.pushed++;
    } else {
        stats.failed++;
        console.error(`push failed ${evt.subject_hash.slice(0, 12)}… HTTP ${result.status}: ${JSON.stringify(result.body).slice(0, 200)}`);
    }
}

stats.duration_ms = Date.now() - startedAt;
console.log(`bridge run complete: ${JSON.stringify(stats)}`);
if (!DRY_RUN) await postHeartbeat(stats);
if (stats.failed > 0) process.exit(1);
