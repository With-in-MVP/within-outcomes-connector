# Within — Vendor Integration Guide

Everything a vendor does to go from zero to full usage-and-outcome analytics.
Two halves: **usage capture** (your MCP server) and **outcome reporting** (your
CRM/billing). They join on one shared decision — the identifier — so that
decision comes first.

---

## 0. The one decision that matters: pick your identifier

Choose the identifier that will represent a user everywhere. Requirements:

- **Unique** — no two users ever share it
- **Stable** — the same user always has it (survives re-login, provider changes)
- **Present on both sides** — returned by your MCP server's `identify()` *and*
  stored on the CRM/billing record for that user

Preference order: **internal account ID** (stable, unguessable) → email
(universal, but guessable and changeable) → auth-provider subject (only if your
CRM stores it — most don't).

Everything joins because both sides hash this same value with the same function.
Nothing raw is ever transmitted; Within stores only the resulting pseudonymous ID.

> **Multi-provider auth?** (Google + GitHub + email login): have `identify()`
> resolve the provider subject to your canonical account ID — the lookup your
> auth layer already does. Never return the raw provider subject.

> **Normalization is part of the contract**: lowercase + trim before hashing
> (the SDK and bridge both do this for you — but if you hash anywhere yourself,
> match it).

---

## 1. Usage capture — your MCP server (~30 min)

**Install** (from Within's registry):

```bash
npm install within-sdk
```

**Instrument** — one call, after all tools are registered:

```ts
import { track } from 'within-sdk';

track(server, 'your-vendor-slug', {
    apiKey: process.env.WITHIN_SDK_API_KEY,          // your ingest key from Within
    apiBaseUrl: process.env.WITHIN_SDK_INGEST_BASE_URL,
    identify: async (request, extra) => {
        // Resolve THIS request to your chosen identifier (section 0).
        // Example: OAuth bearer token → verified claims → account lookup
        const sub = extra?.authInfo?.extra?.sub;
        const account = sub ? await accountFromProviderSub(sub) : null;
        return account ? { userId: account.id } : null;   // null = anonymous
    },
});
```

**What happens automatically, with zero further config:**
- Every tool call is captured (name, arguments, result, duration, errors)
- The `userId` you return is **SHA-256-hashed inside your server** before
  anything is transmitted — raw identity never leaves your process
- Automatic PII redaction runs on every event: identity-named keys stripped,
  secret-named keys masked, PII-shaped strings (emails, phones, cards, tokens)
  redacted, oversized payloads truncated
- An intent field is added to your tools so calling models explain *why* each
  call is made (its description instructs models to include no personal data)

**Optional hardening:**
```ts
    // Your own patterns, applied to every string in every event before ours:
    redactSensitiveInformation: (text) => text.replace(/ACCT-\d{8}/g, '[redacted]'),
    // Extend the masked-key list:
    privacy: { redactKeys: ['license_key', 'internal_cost'] },
```

**Auth note:** identity capture requires your server to know who's calling —
i.e. authenticated MCP (OAuth bearer tokens for remote servers). Unauthenticated
servers still get full usage analytics, but events are anonymous and can never
join to outcomes.

---

## 2. Outcome reporting — pick the door that matches your stack

All three converge on the same Within API and the same hashing. Choose one.

### Door A — you have backend code where outcomes happen (webhook/billing)

Call the SDK helper from your existing conversion logic (e.g. Stripe webhook):

```ts
import { reportConversion } from 'within-sdk';

await reportConversion(
  { vendorSlug: 'your-vendor-slug', apiKey: process.env.WITHIN_SDK_API_KEY },
  { userId: account.id,             // SAME identifier as identify() — section 0
    convertedAt: new Date(),
    plan: { name: 'pro', interval: 'monthly' } },
);
```

The SDK pseudonymizes the userId internally (same hash as usage events) before
anything is sent. Real-time, no infrastructure. *(Requires within-sdk ≥ 1.0.3.)*

### Door B — your outcomes live in a CRM (Salesforce): the Outcomes Connector

A small open-source container you run **in your own cloud**. It reads your CRM,
pseudonymizes identifiers in-process, discards raw fields, and pushes outcome
events to Within. Raw CRM data and CRM credentials never leave your environment.

**B1. Register an API app in your CRM** (~20 min, Salesforce shown):
- Setup → App Manager → New Connected App (or External Client App)
- Enable OAuth → scope "Manage user data via APIs (api)" → enable
  **Client Credentials Flow**
- After saving: Manage → Edit Policies → set the **Run As** user (use a
  read-only integration user in production)
- Collect the **Consumer Key + Secret**

**B2. Know your field API names** (~5 min):
SOQL uses API names, not labels — a field labeled "Outcome" may be
`Outcome__c` or `Outcome1__c`. Find them: Object Manager → your object →
Fields & Relationships (the "Field Name" column).

**B3. Configure** — copy `.env.example`, fill in:

```
SF_INSTANCE_URL=https://your-org.my.salesforce.com
SF_CLIENT_ID=…            SF_CLIENT_SECRET=…
SF_OBJECT=Contact
SF_ID_FIELD=Email                      # ← must be the section-0 identifier
SF_OUTCOME_FIELD=Outcome__c            # ← your API names, not labels
SF_OUTCOME_DATE_FIELD=Outcome_At__c
WITHIN_INGEST_BASE_URL=…   WITHIN_VENDOR_SLUG=…   WITHIN_INGEST_KEY=…
LOOKBACK_DAYS=7
```

(`OUTCOME_MAP` is optional; the default maps converted/upgraded → conversion.
If you customize it on a cloud dashboard, use the single-variable editor —
bulk .env pasting can mangle JSON values.)

**B4. Schedule the container** in your cloud (daily recommended):
- AWS: EventBridge Scheduler → ECS/Fargate task or Lambda container
- GCP: Cloud Run Job + Cloud Scheduler
- Render: Cron Job service, source = "Existing Image"
- Anywhere: `cron` + `docker run --env-file bridge.env <image>`

Image (deploy by digest to pin the version you've reviewed):
```
ghcr.io/with-in-mvp/within-outcomes-connector@sha256:<digest from release notes>
```

The bridge is stateless and idempotent — runs can overlap or repeat harmlessly
(Within deduplicates per subject per day). Each run posts a heartbeat (counts
only) so both sides can see it's alive.

**Trust & audit:** the entire data path is ~200 dependency-free lines of
open source. Verify releases with `cosign verify`; deploy by digest; restrict
egress to your CRM host + Within's API; or build the image from source yourself.

### Door C — your outcomes live in a warehouse (Snowflake/BigQuery/…)

Create a sanitized view producing `identifier, outcome, outcome_date` and run
the bridge's SQL mode against it *(roadmap — ask us for status)*.

---

## 3. Verify the integration (10 min)

1. **Usage**: make a tool call through an authenticated MCP client → confirm
   with Within that the event arrived carrying a pseudonymous `identity_key`.
2. **Outcomes**: trigger one conversion (Door A) or one bridge run (Door B) →
   confirm the conversion event arrived under the *same* `identity_key`.
3. **The join**: Within can now show that user's journey — tool calls in order,
   ending in the outcome. If usage and outcomes show *different* identity keys,
   the two sides are hashing different identifiers → revisit section 0.

---

## Integration checklist (the short version)

- [ ] Choose the canonical identifier (section 0) — same field in `identify()` and CRM
- [ ] `npm install within-sdk`; add `track()` + `identify()` to your MCP server
- [ ] Set `WITHIN_SDK_API_KEY` / ingest URL (from Within)
- [ ] Pick an outcome door: webhook helper (A) or Outcomes Connector (B)
- [ ] Door B: CRM API app → field API names → config → schedule container
- [ ] Run the three verification steps
- [ ] Production hygiene: read-only CRM integration user; pin the bridge digest;
      egress allow-list

**Total effort:** ~30 min (usage) + ~1–2 hrs (outcomes via bridge) or
~15 min (outcomes via webhook). No code beyond the `identify()` callback and,
for Door A, one helper call.

---

## Known limitations & roadmap (honest section)

- **Churn reporting**: not yet ingestible — the bridge counts and skips churned
  rows (visible in run stats); a `reportChurn`/outcome-type API is planned.
- **Vendor-held HMAC secret** (v2): upgrades pseudonymization so hashes can't be
  tested against guessed identifiers by anyone without your key, including
  Within. Requires matching SDK support — **do not set `HASH_SECRET` until your
  SDK version documents it** (and then set the same secret on both your MCP
  server and bridge).
- **CRM adapters**: Salesforce today; HubSpot/others + warehouse SQL mode on the
  roadmap.
- **Minimum SDK version**: use within-sdk ≥ 1.0.3 — earlier versions send a
  legacy field name the conversions API no longer accepts.
- **Terminology**: identifiers are **pseudonymized, not anonymous** — stable
  enough to link a user's activity over time (that's the product), while raw
  identity stays in your systems and cannot be recovered from ours.
