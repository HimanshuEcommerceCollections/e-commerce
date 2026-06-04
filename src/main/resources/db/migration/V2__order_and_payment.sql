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
