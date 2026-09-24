-- Baseline: the Java server's Flyway migrations V1-V10, verbatim and in order.
-- A database already migrated by Flyway to V10 is baselined instead of running
-- this (see src/scripts/migrate.ts).

-- ==== V1__baseline.sql ====
-- ============================================================================
-- V1 — Baseline of the pre-Flyway schema.
--
-- This mirrors what `ddl-auto: update` had been generating. On an EXISTING
-- database it is never executed: baseline-on-migrate marks the DB at V1 and
-- starts applying from V2. On a FRESH database (CI, a new developer) it builds
-- the whole schema from scratch.
--
-- Conventions (must match the JPA entities, since Hibernate runs `validate`):
--   UUID            -> uuid
--   Instant         -> timestamptz   (Hibernate maps Instant to TIMESTAMP_UTC)
--   BigDecimal(p,s) -> numeric(p,s)
--   String          -> varchar(n) / text
--   boolean/int/Long-> boolean / integer / bigint
-- ============================================================================

-- ── users ───────────────────────────────────────────────────────────────────
CREATE TABLE users (
    id                  uuid          NOT NULL PRIMARY KEY,
    created_at          timestamptz   NOT NULL,
    updated_at          timestamptz   NOT NULL,
    deleted             boolean       NOT NULL,
    email               varchar(255)  NOT NULL,
    password            varchar(255)  NOT NULL,
    first_name          varchar(100)  NOT NULL,
    last_name           varchar(100)  NOT NULL,
    display_name        varchar(200),
    role                varchar(20)   NOT NULL,
    enabled             boolean       NOT NULL,
    account_non_locked  boolean       NOT NULL,
    last_login_at       timestamptz,
    CONSTRAINT uk_users_email UNIQUE (email)
);

-- ── product_categories ──────────────────────────────────────────────────────
CREATE TABLE product_categories (
    id           uuid          NOT NULL PRIMARY KEY,
    created_at   timestamptz   NOT NULL,
    updated_at   timestamptz   NOT NULL,
    deleted      boolean       NOT NULL,
    name         varchar(100)  NOT NULL,
    slug         varchar(120)  NOT NULL,
    description  varchar(500),
    CONSTRAINT uk_product_categories_slug UNIQUE (slug)
);

-- ── products ─────────────────────────────────────────────────────────────────
CREATE TABLE products (
    id              uuid           NOT NULL PRIMARY KEY,
    created_at      timestamptz    NOT NULL,
    updated_at      timestamptz    NOT NULL,
    deleted         boolean        NOT NULL,
    name            varchar(255)   NOT NULL,
    description     text,
    price           numeric(12,2)  NOT NULL,
    stock_quantity  integer        NOT NULL,
    sku             varchar(100)   NOT NULL,
    status          varchar(20)    NOT NULL,
    category_id     uuid,
    merchant_id     uuid           NOT NULL,
    version         bigint,
    CONSTRAINT uk_products_sku UNIQUE (sku),
    CONSTRAINT fk_products_category FOREIGN KEY (category_id) REFERENCES product_categories (id)
);

-- ── product_images ───────────────────────────────────────────────────────────
CREATE TABLE product_images (
    id              uuid           NOT NULL PRIMARY KEY,
    created_at      timestamptz    NOT NULL,
    updated_at      timestamptz    NOT NULL,
    deleted         boolean        NOT NULL,
    product_id      uuid           NOT NULL,
    url             varchar(2048)  NOT NULL,
    alt_text        varchar(255),
    position        integer        NOT NULL,
    is_primary      boolean        NOT NULL,
    width           integer,
    height          integer,
    content_type    varchar(100),
    file_size_bytes bigint,
    storage_key     varchar(512),
    CONSTRAINT fk_product_images_product FOREIGN KEY (product_id) REFERENCES products (id)
);
CREATE INDEX idx_product_images_product_id ON product_images (product_id);

-- ── carts ────────────────────────────────────────────────────────────────────
CREATE TABLE carts (
    id          uuid         NOT NULL PRIMARY KEY,
    created_at  timestamptz  NOT NULL,
    updated_at  timestamptz  NOT NULL,
    deleted     boolean      NOT NULL,
    user_id     uuid         NOT NULL
);
CREATE INDEX idx_carts_user_id ON carts (user_id, deleted);

-- ── cart_items ───────────────────────────────────────────────────────────────
CREATE TABLE cart_items (
    id          uuid         NOT NULL PRIMARY KEY,
    created_at  timestamptz  NOT NULL,
    updated_at  timestamptz  NOT NULL,
    deleted     boolean      NOT NULL,
    cart_id     uuid         NOT NULL,
    product_id  uuid         NOT NULL,
    quantity    integer      NOT NULL,
    CONSTRAINT fk_cart_items_cart FOREIGN KEY (cart_id) REFERENCES carts (id)
);
CREATE INDEX idx_cart_items_cart_id ON cart_items (cart_id, deleted);

-- ── user_addresses ───────────────────────────────────────────────────────────
CREATE TABLE user_addresses (
    id              uuid          NOT NULL PRIMARY KEY,
    created_at      timestamptz   NOT NULL,
    updated_at      timestamptz   NOT NULL,
    deleted         boolean       NOT NULL,
    user_id         uuid          NOT NULL,
    label           varchar(50)   NOT NULL,
    recipient_name  varchar(200)  NOT NULL,
    phone           varchar(20),
    address_line1   varchar(255)  NOT NULL,
    address_line2   varchar(255),
    city            varchar(100)  NOT NULL,
    state           varchar(100)  NOT NULL,
    postal_code     varchar(20)   NOT NULL,
    country         varchar(100)  NOT NULL,
    is_default      boolean       NOT NULL
);
CREATE INDEX idx_user_addresses_user_id ON user_addresses (user_id, deleted);

-- ==== V2__order_and_payment.sql ====
-- ============================================================================
-- V2 — Order & checkout tables.
--
-- An order is a self-contained historical record: it snapshots the unit price,
-- product name, SKU and merchant of each line (products are mutable / soft-
-- deletable) and snapshots the shipping address (user_addresses are mutable /
-- soft-deletable). It never references live product/address rows for display.
--
-- Money columns mirror the entity's BigDecimal(12,2). tax/shipping/discount are
-- present and default to 0 so the totals breakdown is future-proof even though
-- v1 only populates subtotal == grand_total. Payment columns are nullable now;
-- they are populated by the (currently manual) payment gateway and, later, Stripe.
-- ============================================================================

-- ── orders ───────────────────────────────────────────────────────────────────
CREATE TABLE orders (
    id                  uuid           NOT NULL PRIMARY KEY,
    created_at          timestamptz    NOT NULL,
    updated_at          timestamptz    NOT NULL,
    deleted             boolean        NOT NULL,
    user_id             uuid           NOT NULL,
    order_number        varchar(40)    NOT NULL,
    status              varchar(30)    NOT NULL,
    currency            varchar(3)     NOT NULL,
    subtotal            numeric(12,2)  NOT NULL,
    tax_total           numeric(12,2)  NOT NULL,
    shipping_total      numeric(12,2)  NOT NULL,
    discount_total      numeric(12,2)  NOT NULL,
    grand_total         numeric(12,2)  NOT NULL,
    payment_status      varchar(20),
    payment_reference   varchar(255),
    payment_intent_id   varchar(255),
    -- shipping address snapshot
    ship_recipient_name varchar(200)   NOT NULL,
    ship_phone          varchar(20),
    ship_address_line1  varchar(255)   NOT NULL,
    ship_address_line2  varchar(255),
    ship_city           varchar(100)   NOT NULL,
    ship_state          varchar(100)   NOT NULL,
    ship_postal_code    varchar(20)    NOT NULL,
    ship_country        varchar(100)   NOT NULL,
    CONSTRAINT uk_orders_order_number UNIQUE (order_number)
);
CREATE INDEX idx_orders_user_id ON orders (user_id, deleted);

-- ── order_items ──────────────────────────────────────────────────────────────
CREATE TABLE order_items (
    id            uuid           NOT NULL PRIMARY KEY,
    created_at    timestamptz    NOT NULL,
    updated_at    timestamptz    NOT NULL,
    deleted       boolean        NOT NULL,
    order_id      uuid           NOT NULL,
    product_id    uuid           NOT NULL,
    merchant_id   uuid           NOT NULL,
    product_name  varchar(255)   NOT NULL,
    sku           varchar(100)   NOT NULL,
    unit_price    numeric(12,2)  NOT NULL,
    quantity      integer        NOT NULL,
    line_total    numeric(12,2)  NOT NULL,
    CONSTRAINT fk_order_items_order FOREIGN KEY (order_id) REFERENCES orders (id)
);
CREATE INDEX idx_order_items_order_id ON order_items (order_id);
CREATE INDEX idx_order_items_merchant_id ON order_items (merchant_id, deleted);

-- Backstop against overselling: stock can never go negative even if application
-- logic regresses. The conditional decrement in ProductRepository is the primary
-- guard; this CHECK is the last line of defence.
ALTER TABLE products ADD CONSTRAINT chk_products_stock_non_negative CHECK (stock_quantity >= 0);

-- ==== V3__owed_partial_indexes.sql ====
-- ============================================================================
-- V3 — Partial unique indexes that JPA cannot express (WHERE clauses).
--
-- These enforce, at the database level, two single-row invariants the services
-- have been maintaining in application code:
--   * at most one DEFAULT address per (live) user
--   * at most one PRIMARY image per (live) product
--
-- If an existing database somehow holds duplicates, this migration will fail —
-- deduplicate those rows first, then re-run. On a fresh database there is no
-- data to conflict.
-- ============================================================================

CREATE UNIQUE INDEX uniq_user_addresses_default
    ON user_addresses (user_id)
    WHERE is_default = true AND deleted = false;

CREATE UNIQUE INDEX uniq_product_images_primary
    ON product_images (product_id)
    WHERE is_primary = true AND deleted = false;

-- ==== V4__stripe_payment_support.sql ====
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

-- ==== V5__user_fullname_phone.sql ====
-- ─────────────────────────────────────────────────────────────────────────────
-- V5 — Collapse first_name/last_name into a single full_name, drop display_name,
--      and add a unique phone_number.
-- Mirrors the updated User entity (Hibernate runs ddl-auto: validate).
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE users ADD COLUMN full_name    varchar(200);
ALTER TABLE users ADD COLUMN phone_number varchar(20);

-- Backfill full_name from the existing first/last names before they are dropped.
UPDATE users SET full_name = btrim(first_name || ' ' || last_name);

ALTER TABLE users ALTER COLUMN full_name SET NOT NULL;

ALTER TABLE users DROP COLUMN first_name;
ALTER TABLE users DROP COLUMN last_name;
ALTER TABLE users DROP COLUMN display_name;

-- Phone is optional for legacy rows (NULL) but unique when present.
-- Postgres treats NULLs as distinct, so multiple NULL phone numbers are allowed.
ALTER TABLE users ADD CONSTRAINT uk_users_phone UNIQUE (phone_number);

-- ==== V6__order_idempotency_and_cancellation.sql ====
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

-- ==== V7__webhook_events.sql ====
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

-- ==== V8__cart_integrity.sql ====
-- ============================================================================
-- V8 — Cart uniqueness: one live cart per user, one live line per product.
--
-- CartService's check-then-insert paths have been racing in production
-- (getOrCreateCart / addItem), so duplicate live carts and duplicate live
-- cart_items rows may already exist — and CREATE UNIQUE INDEX fails on
-- duplicates (see V3's note). This migration therefore dedupes the live data
-- first, then adds the partial unique indexes that make the races impossible.
--
-- Dedupe policy:
--   * carts: keep the newest live cart per user; re-point the losers' live
--     items at it; soft-delete the losers.
--   * cart_items: keep the most recently updated live row per (cart, product)
--     with the summed quantity (capped at the request-level max of 999);
--     soft-delete the rest.
-- Soft-deleted rows may keep duplicates — the indexes only cover deleted=false.
-- ============================================================================

-- Hold off concurrent cart writes from a still-running old app instance (which
-- has the very races being fixed): without this, a duplicate inserted between
-- the dedupe statements and the index build would abort the migration.
LOCK TABLE carts IN SHARE MODE;
LOCK TABLE cart_items IN SHARE MODE;

-- ── 1. Merge duplicate live carts per user ──────────────────────────────────

-- Re-point live items of non-keeper carts at the keeper (newest) cart.
WITH ranked AS (
    SELECT id, user_id,
           ROW_NUMBER() OVER (PARTITION BY user_id ORDER BY created_at DESC, id DESC) AS rn
    FROM carts
    WHERE deleted = false
),
keepers AS (SELECT user_id, id FROM ranked WHERE rn = 1),
losers  AS (SELECT user_id, id FROM ranked WHERE rn > 1)
UPDATE cart_items ci
SET cart_id = k.id, updated_at = now()
FROM losers l
JOIN keepers k ON k.user_id = l.user_id
WHERE ci.cart_id = l.id
  AND ci.deleted = false;

-- Soft-delete the loser carts.
WITH ranked AS (
    SELECT id,
           ROW_NUMBER() OVER (PARTITION BY user_id ORDER BY created_at DESC, id DESC) AS rn
    FROM carts
    WHERE deleted = false
)
UPDATE carts
SET deleted = true, updated_at = now()
WHERE id IN (SELECT id FROM ranked WHERE rn > 1);

-- ── 2. Collapse duplicate live lines per (cart, product) ────────────────────

-- Keeper gets the summed quantity (capped at 999, the per-request max).
WITH ranked AS (
    SELECT id,
           ROW_NUMBER() OVER (PARTITION BY cart_id, product_id ORDER BY updated_at DESC, id DESC) AS rn,
           SUM(quantity)  OVER (PARTITION BY cart_id, product_id) AS total_qty
    FROM cart_items
    WHERE deleted = false
)
UPDATE cart_items ci
SET quantity = LEAST(r.total_qty, 999), updated_at = now()
FROM ranked r
WHERE ci.id = r.id AND r.rn = 1 AND ci.quantity <> LEAST(r.total_qty, 999);

WITH ranked AS (
    SELECT id,
           ROW_NUMBER() OVER (PARTITION BY cart_id, product_id ORDER BY updated_at DESC, id DESC) AS rn
    FROM cart_items
    WHERE deleted = false
)
UPDATE cart_items
SET deleted = true, updated_at = now()
WHERE id IN (SELECT id FROM ranked WHERE rn > 1);

-- ── 3. The invariants, enforced at the database level ───────────────────────

CREATE UNIQUE INDEX uniq_carts_user_live
    ON carts (user_id)
    WHERE deleted = false;

CREATE UNIQUE INDEX uniq_cart_items_cart_product_live
    ON cart_items (cart_id, product_id)
    WHERE deleted = false;

-- ==== V9__referential_integrity.sql ====
-- ============================================================================
-- V9 — Foreign keys for live cross-module references.
--
-- The module-decoupling rule bans JPA relations across modules, not schema
-- constraints: carts/user_addresses/orders reference live users, and
-- cart_items reference live products, so the database should refuse orphans.
-- order_items stays deliberately FK-less to users/products — its columns are
-- historical snapshots.
--
-- ON DELETE RESTRICT everywhere: users and products are soft-deleted, never
-- hard-deleted, so a blocked hard delete is a bug surfacing — not a workflow.
--
-- Orphans (rows whose referent never existed or was hard-deleted out-of-band)
-- are removed first. ADD CONSTRAINT ... NOT VALID + VALIDATE is used for its
-- restart-friendliness; note that because Flyway runs this script in a single
-- transaction, the ADD locks are held until commit anyway — writes to these
-- tables block for the duration of the migration. Run it in a quiet window.
-- ============================================================================

-- ── Orphan cleanup ───────────────────────────────────────────────────────────

DELETE FROM cart_items ci
WHERE NOT EXISTS (SELECT 1 FROM products p WHERE p.id = ci.product_id);

DELETE FROM cart_items ci
WHERE NOT EXISTS (SELECT 1 FROM carts c WHERE c.id = ci.cart_id);

-- Items of carts about to be deleted as orphans must go first, or
-- fk_cart_items_cart (V1) aborts the carts delete below.
DELETE FROM cart_items ci
WHERE EXISTS (
    SELECT 1 FROM carts c
    WHERE c.id = ci.cart_id
      AND NOT EXISTS (SELECT 1 FROM users u WHERE u.id = c.user_id)
);

DELETE FROM carts c
WHERE NOT EXISTS (SELECT 1 FROM users u WHERE u.id = c.user_id);

DELETE FROM user_addresses a
WHERE NOT EXISTS (SELECT 1 FROM users u WHERE u.id = a.user_id);

-- Orders are financial records; an order whose user_id matches no users row is
-- unreachable garbage (every order is created from an authenticated user).
DELETE FROM order_items oi
WHERE EXISTS (
    SELECT 1 FROM orders o
    WHERE o.id = oi.order_id
      AND NOT EXISTS (SELECT 1 FROM users u WHERE u.id = o.user_id)
);
DELETE FROM orders o
WHERE NOT EXISTS (SELECT 1 FROM users u WHERE u.id = o.user_id);

-- ── Foreign keys ─────────────────────────────────────────────────────────────

ALTER TABLE carts
    ADD CONSTRAINT fk_carts_user
    FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE RESTRICT NOT VALID;
ALTER TABLE carts VALIDATE CONSTRAINT fk_carts_user;

ALTER TABLE cart_items
    ADD CONSTRAINT fk_cart_items_product
    FOREIGN KEY (product_id) REFERENCES products (id) ON DELETE RESTRICT NOT VALID;
ALTER TABLE cart_items VALIDATE CONSTRAINT fk_cart_items_product;

ALTER TABLE user_addresses
    ADD CONSTRAINT fk_user_addresses_user
    FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE RESTRICT NOT VALID;
ALTER TABLE user_addresses VALIDATE CONSTRAINT fk_user_addresses_user;

ALTER TABLE orders
    ADD CONSTRAINT fk_orders_user
    FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE RESTRICT NOT VALID;
ALTER TABLE orders VALIDATE CONSTRAINT fk_orders_user;

-- ==== V10__parent_products_and_variants.sql ====
-- ============================================================================
-- V10 — Parent products and variant SKUs (FR-IM-02).
--
-- A parent product is the catalog record customers browse (name, brand,
-- descriptions, category). Each purchasable variant is its own row in
-- `products` — its own SKU, price, stock, images and variant attributes — and
-- points at its parent. Cart, checkout and stock movements keep referencing
-- `products`, i.e. the SKU, so they are untouched.
--
-- Backfill: every existing product becomes a single-variant parent. The parent
-- reuses the product's id and takes its SKU as its code, so no UUID function is
-- needed and the mapping is trivially traceable.
-- ============================================================================

CREATE TABLE parent_products (
    id                 uuid           NOT NULL PRIMARY KEY,
    created_at         timestamptz    NOT NULL,
    updated_at         timestamptz    NOT NULL,
    deleted            boolean        NOT NULL,
    code               varchar(100)   NOT NULL,
    name               varchar(255)   NOT NULL,
    brand              varchar(100),
    short_description  varchar(1000),
    description        text,
    category_id        uuid,
    merchant_id        uuid           NOT NULL,
    CONSTRAINT uk_parent_products_code UNIQUE (code),
    CONSTRAINT fk_parent_products_category FOREIGN KEY (category_id)
        REFERENCES product_categories (id) ON DELETE RESTRICT
);
CREATE INDEX idx_parent_products_category_id ON parent_products (category_id);

ALTER TABLE products
    ADD COLUMN parent_id     uuid,
    ADD COLUMN variant_name  varchar(150),
    ADD COLUMN color         varchar(50),
    ADD COLUMN size          varchar(50),
    ADD COLUMN material      varchar(100),
    ADD COLUMN pattern       varchar(100),
    ADD COLUMN style         varchar(100);

INSERT INTO parent_products (id, created_at, updated_at, deleted, code, name,
                             description, category_id, merchant_id)
SELECT p.id, p.created_at, p.updated_at, p.deleted, p.sku, p.name,
       p.description, p.category_id, p.merchant_id
FROM products p;

UPDATE products SET parent_id = id;

ALTER TABLE products ALTER COLUMN parent_id SET NOT NULL;
ALTER TABLE products
    ADD CONSTRAINT fk_products_parent
    FOREIGN KEY (parent_id) REFERENCES parent_products (id) ON DELETE RESTRICT;
CREATE INDEX idx_products_parent_id ON products (parent_id);
