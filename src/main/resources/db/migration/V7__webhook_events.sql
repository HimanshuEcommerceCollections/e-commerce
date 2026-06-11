-- ============================================================================
-- V7 — Durable webhook event store (replaces processed_webhook_events).
--
-- The old table was a bare idempotency marker: it could only record success,
-- and a failed event left no trace — combined with the previous behaviour of
-- returning 400 on processing errors (which stops Stripe's retries), a real
-- payment event could be lost permanently.
--
-- webhook_events stores the raw signature-verified payload with a status:
--   RECEIVED  → persisted, processing in flight (or crashed mid-flight)
--   PROCESSED → handled successfully (idempotency guard: never re-dispatched)
--   FAILED    → handler threw; payload retained for the admin replay endpoint
--
-- Persisting the event is a separate transaction from processing it, so a
-- processing failure still leaves a FAILED row to replay.
--
-- Guarded like V6: this database historically ran with ddl-auto=update, so
-- either table may already exist (Hibernate-created) or be absent on a given
-- environment — the migration tolerates both.
-- ============================================================================

CREATE TABLE IF NOT EXISTS webhook_events (
    event_id      varchar(255)  NOT NULL PRIMARY KEY,
    event_type    varchar(100),
    payload       text,
    status        varchar(20)   NOT NULL,
    error_message varchar(1000),
    received_at   timestamptz   NOT NULL,
    processed_at  timestamptz
);

CREATE INDEX IF NOT EXISTS idx_webhook_events_status ON webhook_events (status);

-- Carry over the old idempotency markers so already-handled Stripe redeliveries
-- stay no-ops. Their payloads were never stored (NULL → not replayable).
DO $$
BEGIN
    IF to_regclass('public.processed_webhook_events') IS NOT NULL THEN
        INSERT INTO webhook_events (event_id, event_type, payload, status, error_message, received_at, processed_at)
        SELECT event_id, event_type, NULL, 'PROCESSED', NULL, processed_at, processed_at
        FROM processed_webhook_events
        ON CONFLICT (event_id) DO NOTHING;

        DROP TABLE processed_webhook_events;
    END IF;
END $$;
