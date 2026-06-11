-- ============================================================================
-- V6 — Checkout idempotency + cancellation audit columns.
--
--   * idempotency_key / request_hash — a client-supplied Idempotency-Key makes
--     POST /api/orders replay-safe: the same (user, key) can only ever create
--     one order (partial unique index below), and request_hash rejects a key
--     reused with a different request body instead of silently replaying.
--   * cancellation_reason / cancelled_by — who/why for every CANCELLED order
--     (customer action, admin, the pending-payment expiry job, or the gateway).
--   * last_payment_failure_at — records declined attempts. A failed attempt is
--     NOT terminal (the customer can retry the same PaymentIntent), so failure
--     no longer cancels the order or releases stock; this timestamp is the
--     audit trail of attempts.
--   * idx_orders_status_created_at — supports the expiry job's scan for stale
--     PENDING_PAYMENT orders.
-- ============================================================================

ALTER TABLE orders ADD COLUMN IF NOT EXISTS idempotency_key         varchar(80);
ALTER TABLE orders ADD COLUMN IF NOT EXISTS request_hash            varchar(64);
ALTER TABLE orders ADD COLUMN IF NOT EXISTS cancellation_reason     varchar(255);
ALTER TABLE orders ADD COLUMN IF NOT EXISTS cancelled_by            varchar(20);
ALTER TABLE orders ADD COLUMN IF NOT EXISTS last_payment_failure_at timestamptz;

-- One order per (user, key). Partial: rows without a key (header not sent, or
-- pre-V6 orders) are exempt.
CREATE UNIQUE INDEX IF NOT EXISTS uniq_orders_user_idempotency_key
    ON orders (user_id, idempotency_key)
    WHERE idempotency_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_orders_status_created_at
    ON orders (status, created_at);
