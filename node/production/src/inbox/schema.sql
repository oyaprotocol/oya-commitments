-- Version 1 is additive and safe to run repeatedly. Use a dedicated database.
CREATE TABLE IF NOT EXISTS oya_inbox_targets (
    target text PRIMARY KEY,
    execution jsonb NOT NULL,
    schema_version integer NOT NULL DEFAULT 1 CHECK (schema_version = 1)
);
CREATE TABLE IF NOT EXISTS oya_inbox_jobs (
    target text NOT NULL REFERENCES oya_inbox_targets(target),
    request_id uuid NOT NULL,
    payload jsonb NOT NULL,
    payload_hash text NOT NULL,
    expires_at timestamptz NOT NULL,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','processing','published','logged','failed','expired')),
    attempts integer NOT NULL DEFAULT 0,
    lease uuid,
    lease_until timestamptz,
    cid text,
    transaction_data jsonb,
    result jsonb,
    last_error text,
    PRIMARY KEY (target, request_id)
);
CREATE INDEX IF NOT EXISTS oya_inbox_pending ON oya_inbox_jobs(target, status, created_at);
-- Processing includes retries and unresolved Ledger transactions. Never skip this head of line.
CREATE UNIQUE INDEX IF NOT EXISTS oya_inbox_single_active ON oya_inbox_jobs(target) WHERE status = 'processing';
