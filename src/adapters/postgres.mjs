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

export function postgresConfig(env) {
    const req = (name) => {
        const v = env[name];
        if (v === undefined) throw new Error(`missing required env var: ${name}`);
        return v;
    };
    const cfg = {
        connectionString: req('PG_CONNECTION_STRING'),
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

export async function* postgresRows(cfg, lookbackDays) {
    const { default: pg } = await import('pg');
    const client = new pg.Client({ connectionString: cfg.connectionString });
    await client.connect();
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
