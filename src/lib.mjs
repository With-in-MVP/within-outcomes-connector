// Pure transform logic for the privacy bridge — no I/O, no env access.
// Extracted from bridge.mjs so the privacy boundary is unit-testable.

import { createHash, createHmac } from 'node:crypto';

export const ID_NORMALIZE_MODES = ['lowercase', 'none'];

// Must produce byte-identical input to the Within SDK's getSubjectForUserId:
//   sha256(`subject:${vendorSlug.trim().toLowerCase()}:${userId.trim()}`)
// The SDK does NOT lowercase the userId — only the vendor slug. Whether the
// bridge lowercases the raw ID before hashing is controlled by ID_NORMALIZE
// and must match whatever the vendor's identify() callback does.
export function hashSubject(vendorSlug, subject, secret = null) {
    const message = `subject:${vendorSlug.trim().toLowerCase()}:${subject.trim()}`;
    return secret
        ? createHmac('sha256', secret).update(message).digest('hex')
        : createHash('sha256').update(message).digest('hex');
}

export function normalizeRawId(rawId, mode) {
    const value = String(rawId);
    return mode === 'lowercase' ? value.toLowerCase() : value;
}

// The privacy boundary. Raw identifiers do not survive this.
export function toOutcomeEvent(row, config) {
    const outcomeValue = String(row.outcome ?? '').toLowerCase();
    return {
        kind: config.outcomeMap[outcomeValue] ?? 'skip',
        subject: hashSubject(
            config.vendorSlug,
            normalizeRawId(row.rawId, config.idNormalize),
            config.hashSecret,
        ),
        outcome: outcomeValue,
        outcome_at: row.outcomeAt ?? null,
        plan: row.plan ?? null,
    };
}

// outcome_at may be a date-only string ("2026-07-23") from a DATE column or a
// full ISO timestamp from a timestamptz / custom PG_QUERY. Only date-only
// values get a midnight time appended; timestamps pass through unchanged.
export function conversionTimestamps(outcomeAt) {
    if (!outcomeAt) return { converted_at: undefined, conversion_utc_date: undefined };
    const value = String(outcomeAt);
    const utcDate = value.slice(0, 10);
    return {
        converted_at: value.includes('T') ? value : `${utcDate}T00:00:00.000Z`,
        conversion_utc_date: utcDate,
    };
}

export function buildConversionPayload(evt, config) {
    const { converted_at, conversion_utc_date } = conversionTimestamps(evt.outcome_at);
    return {
        vendor_slug: config.vendorSlug,
        subject: evt.subject,
        converted_at,
        conversion_utc_date,
        plan: evt.plan ? { id: evt.plan, name: evt.plan } : undefined,
        metadata: { source: 'within-privacy-bridge', outcome: evt.outcome },
    };
}
