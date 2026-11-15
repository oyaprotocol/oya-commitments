CREATE TABLE IF NOT EXISTS oya_peer_targets (
    target text PRIMARY KEY,
    identity jsonb NOT NULL
);
CREATE TABLE IF NOT EXISTS oya_peer_messages (
    target text NOT NULL REFERENCES oya_peer_targets(target),
    request_id uuid NOT NULL,
    envelope jsonb NOT NULL,
    digest text NOT NULL,
    receipt jsonb NOT NULL,
    retained_until bigint NOT NULL,
    PRIMARY KEY (target, request_id)
);
CREATE INDEX IF NOT EXISTS oya_peer_retention ON oya_peer_messages(target, retained_until);
