import test from 'node:test';
import assert from 'node:assert/strict';
import { postgresConfig, buildQuery, normalizeOutcomeAt } from '../src/adapters/postgres.mjs';

const BASE_ENV = {
    PG_CONNECTION_STRING: 'postgresql://ro:pw@localhost:5432/billing',
    PG_TABLE: 'subscriptions',
    PG_ID_FIELD: 'account_id',
    PG_OUTCOME_FIELD: 'status',
    PG_OUTCOME_DATE_FIELD: 'status_changed_at',
    PG_PLAN_FIELD: 'plan_name',
    PG_MODIFIED_FIELD: 'updated_at',
};

test('postgresConfig requires connection string plus a mode', () => {
    assert.throws(() => postgresConfig({}), /PG_CONNECTION_STRING/);
    assert.throws(
        () => postgresConfig({ PG_CONNECTION_STRING: 'postgresql://x' }),
        /PG_QUERY, or PG_TABLE/,
    );
    assert.ok(postgresConfig(BASE_ENV));
    assert.ok(postgresConfig({ PG_CONNECTION_STRING: 'postgresql://x', PG_QUERY: 'SELECT 1' }));
});

test('field-mapping mode builds a parameterized trailing-window query', () => {
    const cfg = postgresConfig(BASE_ENV);
    const now = Date.parse('2026-07-23T12:00:00.000Z');
    const { text, values } = buildQuery(cfg, 7, now);
    assert.equal(
        text,
        'SELECT account_id AS raw_id, status AS outcome, status_changed_at AS outcome_at, plan_name AS plan '
        + 'FROM subscriptions WHERE account_id IS NOT NULL AND status IS NOT NULL AND updated_at >= $1',
    );
    assert.deepEqual(values, ['2026-07-16T12:00:00.000Z']);
});

test('optional fields fall back to NULL columns and no window', () => {
    const cfg = postgresConfig({
        PG_CONNECTION_STRING: BASE_ENV.PG_CONNECTION_STRING,
        PG_TABLE: 'subscriptions',
        PG_ID_FIELD: 'account_id',
        PG_OUTCOME_FIELD: 'status',
    });
    const { text, values } = buildQuery(cfg, 7);
    assert.match(text, /NULL AS outcome_at, NULL AS plan/);
    assert.ok(!text.includes('$1'));
    assert.deepEqual(values, []);
});

test('custom PG_QUERY passes through untouched', () => {
    const cfg = postgresConfig({
        PG_CONNECTION_STRING: BASE_ENV.PG_CONNECTION_STRING,
        PG_QUERY: 'SELECT account_id AS raw_id, status AS outcome, changed AS outcome_at, plan AS plan FROM v_outcomes',
    });
    const { text, values } = buildQuery(cfg, 7);
    assert.equal(text, cfg.query);
    assert.deepEqual(values, []);
});

test('identifier validation rejects SQL injection attempts', () => {
    const cfg = postgresConfig({ ...BASE_ENV, PG_TABLE: 'subscriptions; DROP TABLE users' });
    assert.throws(() => buildQuery(cfg, 7), /invalid table identifier/);
    const cfg2 = postgresConfig({ ...BASE_ENV, PG_ID_FIELD: 'account_id--' });
    assert.throws(() => buildQuery(cfg2, 7), /invalid id field identifier/);
    // schema-qualified names remain allowed
    const cfg3 = postgresConfig({ ...BASE_ENV, PG_TABLE: 'billing.subscriptions' });
    assert.ok(buildQuery(cfg3, 7).text.includes('FROM billing.subscriptions'));
});

test('normalizeOutcomeAt keeps DATE columns date-only and timestamps full', () => {
    assert.equal(normalizeOutcomeAt(new Date('2026-07-23T00:00:00.000Z')), '2026-07-23');
    assert.equal(normalizeOutcomeAt(new Date('2026-07-23T14:30:05.000Z')), '2026-07-23T14:30:05.000Z');
    assert.equal(normalizeOutcomeAt('2026-07-23'), '2026-07-23');
    assert.equal(normalizeOutcomeAt(null), null);
    assert.equal(normalizeOutcomeAt(undefined), null);
});
