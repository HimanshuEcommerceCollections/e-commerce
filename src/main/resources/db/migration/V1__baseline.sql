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
