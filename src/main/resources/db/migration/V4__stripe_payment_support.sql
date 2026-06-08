-- ============================================================================
-- V4 — Stripe payment support.
--
-- Adds the two pieces the Stripe gateway needs on top of the existing order /
-- payment columns (which already include payment_intent_id, payment_reference
-- and payment_status, present since V2):
--
--   * processed_webhook_events — idempotency ledger. Stripe delivers each event
--     at-least-once; we record every handled event id so a redelivery is a no-op.
--   * idx_orders_payment_intent_id — supports the webhook's lookup of the order
--     by its PaymentIntent id when reconciling an event.
-- ============================================================================

CREATE TABLE processed_webhook_events (
    event_id     varchar(255) NOT NULL PRIMARY KEY,
    event_type   varchar(100),
    processed_at timestamptz  NOT NULL
);

CREATE INDEX idx_orders_payment_intent_id ON orders (payment_intent_id);
