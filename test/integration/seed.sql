-- Fixture mimicking a vendor's Stripe-webhook → Postgres billing table.
CREATE TABLE subscriptions (
    account_id        text,
    status            text,
    status_changed_at date,
    plan_name         text,
    updated_at        timestamptz NOT NULL DEFAULT now()
);

INSERT INTO subscriptions (account_id, status, status_changed_at, plan_name, updated_at) VALUES
    ('john@acme.com',  'converted', now()::date, 'pro',     now()),               -- pushed
    ('Jane@Acme.COM',  'upgraded',  now()::date, 'team',    now()),               -- pushed (lowercased)
    ('old@acme.com',   'converted', '2024-01-01', 'pro',    now() - interval '30 days'), -- outside window
    ('gone@acme.com',  'churned',   now()::date, NULL,      now()),               -- churn: counted, skipped
    ('trial@acme.com', 'trialing',  NULL,        NULL,      now()),               -- unmapped: skipped
    (NULL,             'converted', now()::date, 'pro',     now());               -- null id: skipped

-- The sanitized-view pattern for custom PG_QUERY mode.
CREATE VIEW v_outcomes AS
SELECT account_id AS raw_id, status AS outcome, status_changed_at AS outcome_at, plan_name AS plan
FROM subscriptions
WHERE updated_at > now() - interval '7 days';

-- Read-only user, as recommended for production bridge deployments.
CREATE ROLE bridge_ro LOGIN PASSWORD 'bridge_ro';
GRANT CONNECT ON DATABASE billing TO bridge_ro;
GRANT USAGE ON SCHEMA public TO bridge_ro;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO bridge_ro;
