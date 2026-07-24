# Within Outcomes Connector

A small, open-source, zero-dependency connector that runs **in your cloud environment**,
reads outcome records (conversions, upgrades, churn) from your CRM or billing
database, pseudonymizes the user identifier locally, and sends **only pseudonymous
outcome events** to Within.

**Raw data never leaves your infrastructure.** Within never receives emails, names,
raw IDs, your CRM or database credentials, or your hash secret.

```
YOUR CLOUD ENVIRONMENT                                WITHIN
┌─────────────────────────────────────────────┐
│  CRM / billing DB (Salesforce, Postgres)    │
│    │  raw contacts + outcomes               │
│    ▼                                        │
│  Outcomes Connector (this container)        │
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
| `postgres` | a billing table or sanitized view in your own database | `pg` (the connector's one dependency, loaded only for this adapter) |

The Postgres adapter fits Stripe-webhook → Postgres billing stacks: point it at
your subscriptions table (field mapping) or hand it a query returning
`raw_id, outcome, outcome_at, plan` (the sanitized-view pattern). Use a
read-only database user.

## Setup (~1 hour, no code)

1. **Create read-only access in your source system.**
   - *Salesforce* (`CRM=salesforce`): a Connected App (or External Client App)
     with OAuth + Client Credentials flow, run-as a read-only integration user.
     Collect the Consumer Key/Secret.
   - *Postgres* (`CRM=postgres`): a read-only role with `SELECT` on your
     outcomes table — or, tighter, on a sanitized view exposing only
     `raw_id, outcome, outcome_at, plan`:

     ```sql
     CREATE ROLE connector_ro LOGIN PASSWORD '<long-random-value>';
     GRANT CONNECT ON DATABASE yourdb TO connector_ro;
     GRANT USAGE ON SCHEMA public TO connector_ro;
     GRANT SELECT ON subscriptions TO connector_ro;
     ```

     If the table uses row-level security, add a policy for the role — RLS
     silently returns zero rows otherwise. Use `?sslmode=require` in the
     connection string; verification works out of the box for AWS RDS and
     Supabase (their CA roots ship in the image), and `PG_CA_CERT` covers any
     other private CA.
2. **Fill in the config.** Copy `.env.example` → `connector.env` and follow its
   comments: pick your adapter (`CRM=`), map your outcome values (`OUTCOME_MAP`),
   and point at your fields. The critical value is the ID field (`SF_ID_FIELD` /
   `PG_ID_FIELD`): it must hold the **same identifier your `identify()` callback
   returns** on your MCP server (email, account ID…), normalized the same way
   (`ID_NORMALIZE`). Same identifier on both sides is what makes joins work.
3. **Dry-run once** — `docker run --env-file connector.env <image> --dry-run`
   prints exactly what would be pushed, without sending anything.
4. **Schedule the container** in your cloud (daily recommended):
   - **AWS**: EventBridge Scheduler → ECS Fargate task or Lambda (container image)
   - **GCP**: Cloud Run Job + Cloud Scheduler
   - **Anywhere**: `cron` + `docker run --env-file connector.env ghcr.io/with-in/outcomes-connector@sha256:<pinned digest>`

The connector is **stateless and idempotent**: each run re-reads a trailing window
(`LOOKBACK_DAYS`) of recently modified records and re-pushes; Within deduplicates per
subject per day. Runs can overlap, fail, or double-fire harmlessly. There is no
database and nothing persisted.

Each run ends with a **heartbeat** (counts only — scanned/pushed/deduped/failed) so
both you and Within can see the connector is alive.

Conversions and churn ride separate ingestion endpoints; if the churn endpoint is
not yet live on your ingest host, churned rows are counted, skipped, and retried
automatically on later runs (visible in stats) — conversions are unaffected.

## Auditing & trust

- **Read it**: the entire data path is [`src/`](src/) — ~300 lines across the core
  and adapters. One third-party dependency total (`pg`, used only by the
  postgres adapter); the Salesforce path is Node built-ins only.
- **Verify it**: every release is signed (Sigstore keyless). Verify with
  `cosign verify ghcr.io/with-in/outcomes-connector@<digest>`.
- **Pin it**: deploy by digest (`@sha256:…`), not by tag — the image you audited is
  the image that runs, permanently, until you choose to upgrade.
- **Cage it**: the connector only needs outbound HTTPS to your source system and Within's
  ingest host (plus, for Postgres, a route to your database). Apply an egress allow-list for defense in depth.
- **Or build it yourself**: `docker build .` on the audited commit and run your own
  artifact — you never have to trust our published image at all.

## Roadmap

- **Vendor-held HMAC secret** (`HASH_SECRET`) — upgrades pseudonymization so hashes
  cannot be tested against guessed identifiers by anyone without your key, including
  Within. Requires matching SDK support; do not set until your SDK version documents it.
- **More CRM adapters** (HubSpot, Pipedrive, …) and a warehouse-view mode for teams
  that already centralize CRM data.

## Compliance note

The identifiers produced are **pseudonymized, not anonymous**: they are stable, which
is what allows activity and outcomes to be linked over time. Raw identity never leaves
your environment, and Within cannot reverse the identifiers it receives.
