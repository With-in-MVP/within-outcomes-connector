# Within Outcomes Connector

A small, open-source, zero-dependency connector that runs **in your cloud environment**,
reads outcome records (conversions, upgrades) from your CRM, pseudonymizes the user
identifier locally, and sends **only pseudonymous outcome events** to Within.

**Raw CRM data never leaves your infrastructure.** Within never receives emails, names,
raw IDs, your CRM credentials, or your hash secret.

```
YOUR CLOUD ENVIRONMENT                                WITHIN
┌─────────────────────────────────────────────┐
│  CRM (Salesforce)                           │
│    │  raw contacts + outcomes               │
│    ▼                                        │
│  Outcomes Connector (this container)            │
│    normalize identifier                     │
│    hash it (SHA-256, vendor-scoped)         │──────▶  ingestion API
│    discard all raw fields                   │  hashes  (pseudonymous
│                                             │  only    events only)
└─────────────────────────────────────────────┘
```

The pseudonymous ID is computed with the **same function your Within SDK uses** in your
MCP server, so your usage telemetry and CRM outcomes join automatically — without either
system ever sharing a raw identifier.

## Adapters

| `CRM=` | Source | Dependencies |
|---|---|---|
| `salesforce` (default) | Connected App + SOQL | none — Node built-ins only |
| `postgres` | a billing table or sanitized view in your own database | `pg` (the bridge's one dependency, loaded only for this adapter) |

The Postgres adapter fits Stripe-webhook → Postgres billing stacks: point it at
your subscriptions table (field mapping) or hand it a query returning
`raw_id, outcome, outcome_at, plan` (the sanitized-view pattern). Use a
read-only database user.

## Setup (~1 hour, no code)

1. **Register an API app in your CRM.** Salesforce: a Connected App (or External
   Client App) with OAuth + Client Credentials flow, run-as a read-only integration
   user. Collect the Consumer Key/Secret.
2. **Fill in the config.** Copy `.env.example` → `connector.env`. The critical
   value is `SF_ID_FIELD`: it must hold the **same identifier your `identify()`
   callback returns** on your MCP server (email, account ID…). Same identifier on
   both sides is what makes joins work.
3. **Schedule the container** in your cloud (daily recommended):
   - **AWS**: EventBridge Scheduler → ECS Fargate task or Lambda (container image)
   - **GCP**: Cloud Run Job + Cloud Scheduler
   - **Anywhere**: `cron` + `docker run --env-file connector.env ghcr.io/with-in/outcomes-connector@sha256:<pinned digest>`

The bridge is **stateless and idempotent**: each run re-reads a trailing window
(`LOOKBACK_DAYS`) of recently modified records and re-pushes; Within deduplicates per
subject per day. Runs can overlap, fail, or double-fire harmlessly. There is no
database and nothing persisted.

Each run ends with a **heartbeat** (counts only — scanned/pushed/deduped/failed) so
both you and Within can see the bridge is alive.

## Auditing & trust

- **Read it**: the entire data path is [`src/`](src/) — ~300 lines across the core
  and adapters. One third-party dependency total (`pg`, used only by the
  postgres adapter); the Salesforce path is Node built-ins only.
- **Verify it**: every release is signed (Sigstore keyless). Verify with
  `cosign verify ghcr.io/with-in/outcomes-connector@<digest>`.
- **Pin it**: deploy by digest (`@sha256:…`), not by tag — the image you audited is
  the image that runs, permanently, until you choose to upgrade.
- **Cage it**: the bridge only needs outbound HTTPS to your CRM host and Within's
  ingest host. Apply an egress allow-list for defense in depth.
- **Or build it yourself**: `docker build .` on the audited commit and run your own
  artifact — you never have to trust our published image at all.

## Not in v1 (roadmap)

- **Churn ingestion** — churned rows are counted and skipped (visible in run stats)
  until Within's churn endpoint ships.
- **Vendor-held HMAC secret** (`HASH_SECRET`) — upgrades pseudonymization so hashes
  cannot be tested against guessed identifiers by anyone without your key, including
  Within. Requires matching SDK support; do not set until your SDK version documents it.
- **More CRM adapters** (HubSpot, Pipedrive, …) and a warehouse-view mode for teams
  that already centralize CRM data.

## Compliance note

The identifiers produced are **pseudonymized, not anonymous**: they are stable, which
is what allows activity and outcomes to be linked over time. Raw identity never leaves
your environment, and Within cannot reverse the identifiers it receives.
