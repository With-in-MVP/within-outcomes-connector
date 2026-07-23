// Salesforce adapter: Connected App (client credentials) + SOQL over REST.
// Yields normalized outcome rows: { rawId, outcome, outcomeAt, plan }.
// Zero dependencies — Node built-in fetch only.

export function salesforceConfig(env) {
    const req = (name) => {
        const v = env[name];
        if (v === undefined) throw new Error(`missing required env var: ${name}`);
        return v;
    };
    return {
        instanceUrl: req('SF_INSTANCE_URL').replace(/\/+$/, ''),
        clientId: req('SF_CLIENT_ID'),
        clientSecret: req('SF_CLIENT_SECRET'),
        object: env.SF_OBJECT ?? 'Contact',
        idField: env.SF_ID_FIELD ?? 'Email',
        outcomeField: req('SF_OUTCOME_FIELD'),
        outcomeDateField: req('SF_OUTCOME_DATE_FIELD'),
        planField: env.SF_PLAN_FIELD || null,
    };
}

export async function* salesforceRows(cfg, lookbackDays) {
    const tokenRes = await fetch(`${cfg.instanceUrl}/services/oauth2/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
            grant_type: 'client_credentials',
            client_id: cfg.clientId,
            client_secret: cfg.clientSecret,
        }),
    });
    const tokenBody = await tokenRes.json();
    if (!tokenBody.access_token) throw new Error(`salesforce auth failed: ${JSON.stringify(tokenBody)}`);

    const fields = [cfg.idField, cfg.outcomeField, cfg.outcomeDateField, cfg.planField].filter(Boolean).join(', ');
    const since = new Date(Date.now() - lookbackDays * 86_400_000).toISOString();
    const soql = `SELECT ${fields} FROM ${cfg.object} `
        + `WHERE ${cfg.idField} != null AND ${cfg.outcomeField} != null `
        + `AND LastModifiedDate >= ${since}`;

    let url = `${cfg.instanceUrl}/services/data/v61.0/query?q=${encodeURIComponent(soql)}`;
    while (url) {
        const res = await fetch(url, { headers: { Authorization: `Bearer ${tokenBody.access_token}` } });
        const body = await res.json();
        if (!body.records) throw new Error(`salesforce query failed: ${JSON.stringify(body).slice(0, 300)}`);
        for (const r of body.records) {
            yield {
                rawId: r[cfg.idField],
                outcome: r[cfg.outcomeField],
                outcomeAt: r[cfg.outcomeDateField] ?? null,
                plan: cfg.planField ? (r[cfg.planField] ?? null) : null,
            };
        }
        url = body.nextRecordsUrl ? `${cfg.instanceUrl}${body.nextRecordsUrl}` : null;
    }
}
