// Postgres adapter: reads outcome rows from a table (or a custom query) in the
// vendor's own database — the natural fit for Stripe-webhook → Postgres billing
// stacks. Yields normalized outcome rows: { rawId, outcome, outcomeAt, plan }.
//
// This is the bridge's ONE third-party dependency (`pg` — Node has no built-in
// Postgres client). It is imported only when CRM=postgres.
//
// Two modes:
//   1. Field mapping (like the Salesforce adapter): PG_TABLE + PG_*_FIELD vars,
//      with optional PG_MODIFIED_FIELD for the idempotent trailing window.
//   2. Custom SQL: PG_QUERY, which must return columns
//      raw_id, outcome, outcome_at, plan — the "sanitized view" pattern.

import { readFileSync, readdirSync } from 'node:fs';
import { rootCertificates } from 'node:tls';

export function postgresConfig(env) {
    const req = (name) => {
        const v = env[name];
        if (v === undefined) throw new Error(`missing required env var: ${name}`);
        return v;
    };
    const cfg = {
        connectionString: req('PG_CONNECTION_STRING'),
        // Escape hatch for providers whose CA isn't bundled in certs/ —
        // the CA certificate PEM contents, pasted directly into the env var.
        caCert: env.PG_CA_CERT || null,
        query: env.PG_QUERY || null,
        table: env.PG_TABLE || null,
        idField: env.PG_ID_FIELD || null,
        outcomeField: env.PG_OUTCOME_FIELD || null,
        outcomeDateField: env.PG_OUTCOME_DATE_FIELD || null,
        planField: env.PG_PLAN_FIELD || null,
        modifiedField: env.PG_MODIFIED_FIELD || null,
    };
    if (!cfg.query && !(cfg.table && cfg.idField && cfg.outcomeField)) {
        throw new Error('postgres adapter needs either PG_QUERY, or PG_TABLE + PG_ID_FIELD + PG_OUTCOME_FIELD');
    }
    return cfg;
}

// Identifiers (table/column names) can't be parameterized in SQL; they come from
// the vendor's own env, but validate anyway so a typo fails loudly and nothing
// interpolates un-vetted.
function ident(name, what) {
    if (!/^[A-Za-z_][A-Za-z0-9_.]*$/.test(name)) {
        throw new Error(`invalid ${what} identifier: ${JSON.stringify(name)}`);
    }
    return name;
}

// Exported for tests. Returns the { text, values } passed to client.query().
export function buildQuery(cfg, lookbackDays, now = Date.now()) {
    if (cfg.query) {
        return { text: cfg.query, values: [] };     // sanitized-view mode: vendor-authored SQL
    }
    const cols = [
        `${ident(cfg.idField, 'id field')} AS raw_id`,
        `${ident(cfg.outcomeField, 'outcome field')} AS outcome`,
        cfg.outcomeDateField ? `${ident(cfg.outcomeDateField, 'outcome date field')} AS outcome_at` : `NULL AS outcome_at`,
        cfg.planField ? `${ident(cfg.planField, 'plan field')} AS plan` : `NULL AS plan`,
    ].join(', ');
    let text = `SELECT ${cols} FROM ${ident(cfg.table, 'table')} `
        + `WHERE ${ident(cfg.idField, 'id field')} IS NOT NULL `
        + `AND ${ident(cfg.outcomeField, 'outcome field')} IS NOT NULL`;
    let values = [];
    if (cfg.modifiedField) {
        text += ` AND ${ident(cfg.modifiedField, 'modified field')} >= $1`;
        values = [new Date(now - lookbackDays * 86_400_000).toISOString()];
    }
    return { text, values };
}

// A DATE column comes back as a Date pinned to midnight UTC — keep just the
// date part so it isn't misread as a real timestamp. Anything with a time
// component keeps its full ISO form.
export function normalizeOutcomeAt(value) {
    if (value instanceof Date) {
        const iso = value.toISOString();
        return iso.endsWith('T00:00:00.000Z') ? iso.slice(0, 10) : iso;
    }
    return value ?? null;
}

// Managed Postgres providers (AWS RDS, Supabase, ...) sign their server certs
// with private CAs that are not in Node's default trust store, so strict TLS
// verification fails out of the box. We bundle those providers' published CA
// roots (certs/ in the repo/image) and trust them IN ADDITION to the default
// store — vendors on those providers get verified TLS with zero config, and
// anyone else can supply their CA via PG_CA_CERT.
function bundledCas() {
    try {
        const dir = new URL('../../certs/', import.meta.url);
        return readdirSync(dir)
            .filter((f) => /\.(pem|crt)$/.test(f))
            .map((f) => readFileSync(new URL(f, dir), 'utf8'));
    } catch {
        return [];
    }
}

// Exported for tests. Returns { connectionString, ssl } for pg.Client.
// ssl is null for local/unencrypted databases (the string speaks for itself).
// When we do supply an ssl object, sslmode is STRIPPED from the string —
// pg's connection-string parser otherwise overrides the explicit ssl option
// with its own (default-trust-store) interpretation of sslmode.
export function buildSslConfig(connectionString, caCert = null) {
    const mode = /[?&]sslmode=([^&]+)/.exec(connectionString)?.[1] ?? null;
    if (mode === null || mode === 'disable') return { connectionString, ssl: null };
    const stripped = connectionString
        .replace(/([?&])sslmode=[^&]*/, '$1')
        .replace(/\?&/, '?')
        .replace(/&&/, '&')
        .replace(/[?&]$/, '');
    const ssl = mode === 'no-verify'
        ? { rejectUnauthorized: false }
        : { ca: [...rootCertificates, ...bundledCas(), ...(caCert ? [caCert] : [])] };
    return { connectionString: stripped, ssl };
}

const TLS_ERROR_CODES = new Set([
    'SELF_SIGNED_CERT_IN_CHAIN', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
    'DEPTH_ZERO_SELF_SIGNED_CERT', 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
    'CERT_HAS_EXPIRED', 'ERR_TLS_CERT_ALTNAME_INVALID',
]);

export async function* postgresRows(cfg, lookbackDays) {
    const { default: pg } = await import('pg');
    const { connectionString, ssl } = buildSslConfig(cfg.connectionString, cfg.caCert);
    const client = new pg.Client({ connectionString, ...(ssl ? { ssl } : {}) });
    try {
        await client.connect();
    } catch (err) {
        if (TLS_ERROR_CODES.has(err?.code)) {
            throw new Error(
                `TLS certificate verification failed (${err.code}). Your database provider `
                + `likely uses a private CA. AWS RDS and Supabase CAs are bundled and should `
                + `work automatically — for other providers, download the CA certificate from `
                + `your provider and set PG_CA_CERT to its PEM contents. For a NON-PRODUCTION `
                + `smoke test only, you can set sslmode=no-verify in PG_CONNECTION_STRING.`,
                { cause: err },
            );
        }
        throw err;
    }
    try {
        const res = await client.query(buildQuery(cfg, lookbackDays));
        for (const r of res.rows) {
            yield {
                rawId: r.raw_id,
                outcome: r.outcome,
                outcomeAt: normalizeOutcomeAt(r.outcome_at),
                plan: r.plan ?? null,
            };
        }
    } finally {
        await client.end();
    }
}
