import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
    hashSubject,
    normalizeRawId,
    toOutcomeEvent,
    conversionTimestamps,
    buildConversionPayload,
} from '../src/lib.mjs';

// Byte-for-byte copy of the Within SDK's getSubjectForUserId (within-sdk
// src/modules/privacy.ts). If this test fails, usage and outcomes no longer
// join — treat as a release blocker.
function sdkGetSubjectForUserId(vendorSlug, userId) {
    return createHash('sha256')
        .update(`subject:${vendorSlug.trim().toLowerCase()}:${userId.trim()}`)
        .digest('hex');
}

const CONFIG = {
    vendorSlug: 'acme',
    hashSecret: null,
    idNormalize: 'lowercase',
    outcomeMap: { converted: 'conversion', upgraded: 'conversion', churned: 'churn' },
};

test('hashSubject matches the SDK construction exactly', () => {
    assert.equal(hashSubject('acme', 'user-123'), sdkGetSubjectForUserId('acme', 'user-123'));
    assert.equal(hashSubject(' Acme ', ' user-123 '), sdkGetSubjectForUserId('acme', 'user-123'));
    // The SDK preserves userId case — the bridge must too (normalization is separate).
    assert.equal(hashSubject('acme', 'User-ABC'), sdkGetSubjectForUserId('acme', 'User-ABC'));
    assert.notEqual(hashSubject('acme', 'User-ABC'), hashSubject('acme', 'user-abc'));
});

test('normalizeRawId modes', () => {
    assert.equal(normalizeRawId('John@Acme.COM', 'lowercase'), 'john@acme.com');
    assert.equal(normalizeRawId('cus_AbC123', 'none'), 'cus_AbC123');
    assert.equal(normalizeRawId(42, 'lowercase'), '42');
});

test('joins when identify() lowercases and bridge normalizes lowercase', () => {
    // identify(): return { userId: email.toLowerCase().trim() }
    const sdkSide = sdkGetSubjectForUserId('acme', 'john@acme.com');
    const evt = toOutcomeEvent({ rawId: 'John@Acme.COM', outcome: 'converted' }, CONFIG);
    assert.equal(evt.subject, sdkSide);
});

test('joins on case-sensitive IDs with ID_NORMALIZE=none', () => {
    const sdkSide = sdkGetSubjectForUserId('acme', 'cus_AbC123');
    const evt = toOutcomeEvent(
        { rawId: 'cus_AbC123', outcome: 'converted' },
        { ...CONFIG, idNormalize: 'none' },
    );
    assert.equal(evt.subject, sdkSide);
});

test('toOutcomeEvent maps outcomes and skips unmapped ones', () => {
    assert.equal(toOutcomeEvent({ rawId: 'a', outcome: 'Converted' }, CONFIG).kind, 'conversion');
    assert.equal(toOutcomeEvent({ rawId: 'a', outcome: 'churned' }, CONFIG).kind, 'churn');
    assert.equal(toOutcomeEvent({ rawId: 'a', outcome: 'trialing' }, CONFIG).kind, 'skip');
    assert.equal(toOutcomeEvent({ rawId: 'a', outcome: null }, CONFIG).kind, 'skip');
});

test('toOutcomeEvent carries no raw identifier', () => {
    const evt = toOutcomeEvent({ rawId: 'john@acme.com', outcome: 'converted', plan: 'pro' }, CONFIG);
    assert.ok(!JSON.stringify(evt).includes('john@acme.com'));
    assert.match(evt.subject, /^[0-9a-f]{64}$/);
});

test('conversionTimestamps handles date-only and full timestamps', () => {
    assert.deepEqual(conversionTimestamps('2026-07-23'), {
        converted_at: '2026-07-23T00:00:00.000Z',
        conversion_utc_date: '2026-07-23',
    });
    assert.deepEqual(conversionTimestamps('2026-07-23T14:30:05.000Z'), {
        converted_at: '2026-07-23T14:30:05.000Z',
        conversion_utc_date: '2026-07-23',
    });
    assert.deepEqual(conversionTimestamps(null), {
        converted_at: undefined,
        conversion_utc_date: undefined,
    });
});

test('buildConversionPayload shape', () => {
    const evt = toOutcomeEvent(
        { rawId: 'a@b.co', outcome: 'converted', outcomeAt: '2026-07-23', plan: 'pro' },
        CONFIG,
    );
    const payload = buildConversionPayload(evt, CONFIG);
    assert.equal(payload.vendor_slug, 'acme');
    assert.equal(payload.subject, evt.subject);
    assert.equal(payload.converted_at, '2026-07-23T00:00:00.000Z');
    assert.equal(payload.conversion_utc_date, '2026-07-23');
    assert.deepEqual(payload.plan, { id: 'pro', name: 'pro' });
    assert.deepEqual(payload.metadata, { source: 'within-outcomes-connector', outcome: 'converted' });
    assert.ok(!JSON.stringify(payload).includes('a@b.co'));
});

test('HMAC mode produces a different, stable subject', () => {
    const plain = hashSubject('acme', 'user-1');
    const hmac = hashSubject('acme', 'user-1', 'secret');
    assert.notEqual(plain, hmac);
    assert.equal(hmac, hashSubject('acme', 'user-1', 'secret'));
});

test('outcomeIdempotencyKey is deterministic and per-day', async () => {
    const { outcomeIdempotencyKey } = await import('../src/lib.mjs');
    const a = outcomeIdempotencyKey('ab'.repeat(32), 'churn', '2026-07-24');
    assert.match(a, /^[0-9a-f]{64}$/);
    assert.equal(a, outcomeIdempotencyKey('ab'.repeat(32), 'churn', '2026-07-24T15:30:00.000Z'));
    assert.notEqual(a, outcomeIdempotencyKey('ab'.repeat(32), 'churn', '2026-07-25'));
    assert.notEqual(a, outcomeIdempotencyKey('ab'.repeat(32), 'conversion', '2026-07-24'));
});

test('buildOutcomeItem matches the /api/crm/outcomes contract', async () => {
    const { buildOutcomeItem } = await import('../src/lib.mjs');
    const cfg = { ...CONFIG, outcomeSourceMapping: 'postgres.subscriptions.status' };
    const evt = toOutcomeEvent(
        { rawId: 'gone@acme.com', outcome: 'churned', outcomeAt: '2026-07-24', plan: 'starter' },
        cfg,
    );
    const item = buildOutcomeItem(evt, cfg, '2026-07-24T09:00:00.000Z');
    assert.match(item.idempotency_key, /^[0-9a-f]{64}$/);
    assert.match(item.subject, /^[0-9a-f]{64}$/);
    assert.equal(item.outcome_type, 'churn');
    assert.equal(item.occurred_at, '2026-07-24T00:00:00.000Z');
    assert.equal(item.source_mapping, 'postgres.subscriptions.status');
    assert.deepEqual(item.plan, { id: 'starter', name: 'starter' });
    assert.ok(!JSON.stringify(item).includes('gone@acme.com'));
    // no outcome date -> falls back to the run timestamp
    const noDate = toOutcomeEvent({ rawId: 'x@y.co', outcome: 'churned' }, cfg);
    assert.equal(buildOutcomeItem(noDate, cfg, '2026-07-24T09:00:00.000Z').occurred_at, '2026-07-24T09:00:00.000Z');
});
