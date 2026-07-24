// End-to-end: real Postgres (docker compose) → bridge → stub Within ingest.
// Run via `npm run test:integration`, which brings the database up first.
// Skips (rather than fails) if the fixture database is not reachable.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { startStubIngest, received } from './stub-ingest.mjs';

const exec = promisify(execFile);
const BRIDGE = new URL('../../src/bridge.mjs', import.meta.url).pathname;
const PG_URL = process.env.BRIDGE_TEST_PG ?? 'postgresql://bridge_ro:bridge_ro@127.0.0.1:55432/billing';

const sdkSubject = (slug, userId) =>
    createHash('sha256').update(`subject:${slug}:${userId}`).digest('hex');

async function pgUp() {
    try {
        const { default: pg } = await import('pg');
        const c = new pg.Client({ connectionString: PG_URL, connectionTimeoutMillis: 2000 });
        await c.connect();
        await c.end();
        return true;
    } catch {
        return false;
    }
}

function runBridge(extraEnv, ingestPort) {
    return exec('node', [BRIDGE], {
        env: {
            ...process.env,
            CRM: 'postgres',
            PG_CONNECTION_STRING: PG_URL,
            WITHIN_INGEST_BASE_URL: `http://127.0.0.1:${ingestPort}`,
            WITHIN_VENDOR_SLUG: 'acme',
            WITHIN_INGEST_KEY: 'test-key',
            LOOKBACK_DAYS: '7',
            ...extraEnv,
        },
    });
}

const FIELD_ENV = {
    PG_TABLE: 'subscriptions',
    PG_ID_FIELD: 'account_id',
    PG_OUTCOME_FIELD: 'status',
    PG_OUTCOME_DATE_FIELD: 'status_changed_at',
    PG_PLAN_FIELD: 'plan_name',
    PG_MODIFIED_FIELD: 'updated_at',
};

test('privacy bridge end-to-end against Postgres', { timeout: 60_000 }, async (t) => {
    if (!(await pgUp())) {
        t.skip(`fixture Postgres not reachable at ${PG_URL} — run npm run test:integration`);
        return;
    }
    const { server, port } = await startStubIngest();
    t.after(() => server.close());

    await t.test('field-mapping mode pushes exactly the joinable outcomes', async () => {
        received.conversions.length = 0;
        received.outcomes.length = 0;
        const { stdout } = await runBridge(FIELD_ENV, port);
        const stats = JSON.parse(stdout.match(/bridge run complete \[postgres\]: (\{.*\})/)[1]);

        // seed: 6 rows — 1 outside the window, 1 null-id filtered in SQL →
        // 4 scanned: 2 conversions, 1 churn pushed, 1 unmapped skipped
        assert.equal(stats.scanned, 4);
        assert.equal(stats.pushed, 2);
        assert.equal(stats.churn_pushed, 1);
        assert.equal(stats.churn_skipped, 0);
        assert.equal(stats.unmapped_skipped, 1);

        // the churned row went through /api/crm/outcomes with the full contract
        const outcomeItems = received.outcomes.flatMap((b) => b.outcomes);
        assert.equal(outcomeItems.length, 1);
        assert.equal(outcomeItems[0].outcome_type, 'churn');
        assert.match(outcomeItems[0].idempotency_key, /^[0-9a-f]{64}$/);
        assert.equal(outcomeItems[0].subject, sdkSubject('acme', 'gone@acme.com'));
        assert.equal(received.outcomes[0].source, 'postgres');
        assert.equal(stats.failed, 0);

        const subjects = received.conversions.map((c) => c.subject).sort();
        assert.deepEqual(subjects, [
            sdkSubject('acme', 'jane@acme.com'),   // Jane@Acme.COM lowercased by default
            sdkSubject('acme', 'john@acme.com'),
        ].sort());

        // privacy boundary: no raw identifier ever crosses the wire
        const wire = JSON.stringify(received.conversions);
        assert.ok(!/acme\.com/i.test(wire.replace(/"vendor_slug":"acme"/g, '')));
    });

    await t.test('re-run is idempotent: server dedup turns pushes into deduped', async () => {
        const { stdout } = await runBridge(FIELD_ENV, port);
        const stats = JSON.parse(stdout.match(/bridge run complete \[postgres\]: (\{.*\})/)[1]);
        assert.equal(stats.pushed, 0);
        assert.equal(stats.deduped, 2);
        assert.equal(stats.churn_pushed, 0);
        assert.equal(stats.churn_deduped, 1);
        assert.equal(stats.failed, 0);
    });

    await t.test('custom PG_QUERY sanitized-view mode matches field mapping', async () => {
        received.conversions.length = 0;
        const { stdout } = await runBridge({
            PG_QUERY: 'SELECT raw_id, outcome, outcome_at, plan FROM v_outcomes',
        }, port);
        const stats = JSON.parse(stdout.match(/bridge run complete \[postgres\]: (\{.*\})/)[1]);
        assert.equal(stats.scanned, 5);
        assert.equal(stats.deduped + stats.pushed, 2);
        assert.equal(stats.failed, 0);
    });

    await t.test('dry-run pushes nothing over the wire', async () => {
        received.conversions.length = 0;
        received.events.length = 0;
        await exec('node', [BRIDGE, '--dry-run'], {
            env: { ...process.env, CRM: 'postgres', PG_CONNECTION_STRING: PG_URL,
                WITHIN_INGEST_BASE_URL: `http://127.0.0.1:${port}`,
                WITHIN_VENDOR_SLUG: 'acme', WITHIN_INGEST_KEY: 'test-key',
                LOOKBACK_DAYS: '7', ...FIELD_ENV },
        });
        assert.equal(received.conversions.length, 0);
        assert.equal(received.events.length, 0);
    });
});
