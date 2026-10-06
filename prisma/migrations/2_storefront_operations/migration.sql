-- Storefront + operations build (Oct 2026): taxonomy, catalog template fields,
-- guest checkout, fulfilment, shipments, returns, stock audit, analytics,
-- notifications, password reset, seller applications, support messages.
--
-- Additive except one relaxation: orders.user_id becomes nullable (guest
-- orders). Nothing here touches the partial unique indexes or the stock CHECK
-- from 0_init. The two partial indexes at the end exist only in this SQL
-- (Prisma can't express partial indexes).

-- AlterTable
ALTER TABLE "order_items" ADD COLUMN     "color" VARCHAR(50),
ADD COLUMN     "image_url" VARCHAR(2048),
ADD COLUMN     "returned_quantity" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "size" VARCHAR(50),
ADD COLUMN     "tax_amount" DECIMAL(12,2) NOT NULL DEFAULT 0,
ADD COLUMN     "tax_code" VARCHAR(50),
ADD COLUMN     "tax_rate" DECIMAL(5,2) NOT NULL DEFAULT 0,
ADD COLUMN     "variant_name" VARCHAR(150);

-- AlterTable
ALTER TABLE "orders" ADD COLUMN     "customer_email" VARCHAR(255),
ADD COLUMN     "delivered_at" TIMESTAMPTZ(6),
ADD COLUMN     "fulfilment_status" VARCHAR(20),
ADD COLUMN     "guest_token_hash" VARCHAR(64),
ADD COLUMN     "marketing_opt_in" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "paid_at" TIMESTAMPTZ(6),
ADD COLUMN     "refunded_total" DECIMAL(12,2) NOT NULL DEFAULT 0,
ADD COLUMN     "shipped_at" TIMESTAMPTZ(6),
ADD COLUMN     "shipping_method" VARCHAR(20),
ALTER COLUMN "user_id" DROP NOT NULL;

-- AlterTable
ALTER TABLE "parent_products" ADD COLUMN     "attributes" JSONB NOT NULL DEFAULT '{}',
ADD COLUMN     "featured" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "infographic_url" VARCHAR(2048),
ADD COLUMN     "key_features" TEXT,
ADD COLUMN     "lifestyle_image_url" VARCHAR(2048),
ADD COLUMN     "product_type" VARCHAR(100),
ADD COLUMN     "size_chart_url" VARCHAR(2048),
ADD COLUMN     "subcategory_id" UUID,
ADD COLUMN     "usage_instructions" TEXT,
ADD COLUMN     "warranty" VARCHAR(500),
ADD COLUMN     "whats_included" TEXT;

-- AlterTable
ALTER TABLE "product_categories" ADD COLUMN     "code" VARCHAR(10),
ADD COLUMN     "parent_id" UUID,
ADD COLUMN     "position" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "product_images" ADD COLUMN     "check_error" VARCHAR(500),
ADD COLUMN     "check_status" VARCHAR(20),
ADD COLUMN     "checked_at" TIMESTAMPTZ(6);

-- AlterTable
ALTER TABLE "products" ADD COLUMN     "cost" DECIMAL(12,2),
ADD COLUMN     "dimensions" VARCHAR(255),
ADD COLUMN     "low_stock_threshold" INTEGER,
ADD COLUMN     "meta_description" VARCHAR(500),
ADD COLUMN     "mrp" DECIMAL(12,2),
ADD COLUMN     "search_keywords" VARCHAR(1000),
ADD COLUMN     "seo_title" VARCHAR(255),
ADD COLUMN     "shipping_class" VARCHAR(50),
ADD COLUMN     "specifications" TEXT,
ADD COLUMN     "supplier_id" VARCHAR(100),
ADD COLUMN     "tax_code" VARCHAR(50),
ADD COLUMN     "tax_rate" DECIMAL(5,2),
ADD COLUMN     "url_slug" VARCHAR(255),
ADD COLUMN     "warehouse_id" VARCHAR(100),
ADD COLUMN     "weight" VARCHAR(100);

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "marketing_opt_in" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "password_changed_at" TIMESTAMPTZ(6);

-- CreateTable
CREATE TABLE "order_events" (
    "id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "order_id" UUID NOT NULL,
    "status" VARCHAR(30),
    "fulfilment_status" VARCHAR(20),
    "note" VARCHAR(1000),
    "actor" VARCHAR(255),

    CONSTRAINT "order_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "shipments" (
    "id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "order_id" UUID NOT NULL,
    "provider" VARCHAR(30) NOT NULL,
    "carrier" VARCHAR(100),
    "service" VARCHAR(100),
    "tracking_number" VARCHAR(100),
    "tracking_url" VARCHAR(2048),
    "label_url" VARCHAR(2048),
    "provider_reference" VARCHAR(255),
    "status" VARCHAR(30) NOT NULL,
    "delivered_at" TIMESTAMPTZ(6),

    CONSTRAINT "shipments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "shipment_events" (
    "id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "shipment_id" UUID NOT NULL,
    "status" VARCHAR(30) NOT NULL,
    "description" VARCHAR(500),
    "location" VARCHAR(200),
    "occurred_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "shipment_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "order_returns" (
    "id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "order_id" UUID NOT NULL,
    "rma_number" VARCHAR(40) NOT NULL,
    "status" VARCHAR(20) NOT NULL,
    "reason" VARCHAR(1000) NOT NULL,
    "method" VARCHAR(20),
    "requested_by" VARCHAR(20) NOT NULL,
    "admin_note" VARCHAR(1000),
    "refund_amount" DECIMAL(12,2),
    "refund_reference" VARCHAR(255),
    "restocked" BOOLEAN NOT NULL DEFAULT false,
    "received_at" TIMESTAMPTZ(6),
    "refunded_at" TIMESTAMPTZ(6),

    CONSTRAINT "order_returns_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "order_return_items" (
    "id" UUID NOT NULL,
    "return_id" UUID NOT NULL,
    "order_item_id" UUID NOT NULL,
    "quantity" INTEGER NOT NULL,

    CONSTRAINT "order_return_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "stock_movements" (
    "id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "product_id" UUID NOT NULL,
    "delta" INTEGER NOT NULL,
    "quantity_after" INTEGER NOT NULL,
    "source" VARCHAR(20) NOT NULL,
    "reason" VARCHAR(500),
    "actor" VARCHAR(255),

    CONSTRAINT "stock_movements_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "analytics_events" (
    "id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "event_type" VARCHAR(30) NOT NULL,
    "session_id" VARCHAR(100),
    "user_id" UUID,
    "product_id" UUID,
    "order_id" UUID,
    "value" DECIMAL(12,2),
    "currency" VARCHAR(3),
    "path" VARCHAR(2048),
    "properties" JSONB,

    CONSTRAINT "analytics_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notifications" (
    "id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "order_id" UUID,
    "user_id" UUID,
    "template" VARCHAR(40) NOT NULL,
    "subject" VARCHAR(255) NOT NULL,
    "to_address" VARCHAR(255) NOT NULL,
    "body" TEXT NOT NULL,
    "status" VARCHAR(20) NOT NULL,

    CONSTRAINT "notifications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "password_reset_tokens" (
    "id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "user_id" UUID NOT NULL,
    "token_hash" VARCHAR(64) NOT NULL,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "used_at" TIMESTAMPTZ(6),

    CONSTRAINT "password_reset_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "seller_applications" (
    "id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reference" VARCHAR(20) NOT NULL,
    "full_name" VARCHAR(200) NOT NULL,
    "email" VARCHAR(255) NOT NULL,
    "phone" VARCHAR(30) NOT NULL,
    "categories" TEXT[],
    "products" TEXT NOT NULL,
    "street" VARCHAR(255) NOT NULL,
    "city" VARCHAR(100) NOT NULL,
    "state" VARCHAR(100) NOT NULL,
    "postal_code" VARCHAR(20) NOT NULL,
    "status" VARCHAR(20) NOT NULL DEFAULT 'NEW',

    CONSTRAINT "seller_applications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "support_messages" (
    "id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ticket_number" VARCHAR(20) NOT NULL,
    "name" VARCHAR(200) NOT NULL,
    "email" VARCHAR(255) NOT NULL,
    "topic" VARCHAR(50) NOT NULL,
    "order_number" VARCHAR(40),
    "message" TEXT NOT NULL,
    "status" VARCHAR(20) NOT NULL DEFAULT 'OPEN',

    CONSTRAINT "support_messages_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "idx_order_events_order_id" ON "order_events"("order_id", "created_at");

-- CreateIndex
CREATE INDEX "idx_shipments_order_id" ON "shipments"("order_id");

-- CreateIndex
CREATE INDEX "idx_shipments_tracking_number" ON "shipments"("tracking_number");

-- CreateIndex
CREATE INDEX "idx_shipment_events_shipment_id" ON "shipment_events"("shipment_id", "occurred_at");

-- CreateIndex
CREATE UNIQUE INDEX "uk_order_returns_rma_number" ON "order_returns"("rma_number");

-- CreateIndex
CREATE INDEX "idx_order_returns_order_id" ON "order_returns"("order_id");

-- CreateIndex
CREATE INDEX "idx_order_returns_status_created_at" ON "order_returns"("status", "created_at");

-- CreateIndex
CREATE INDEX "idx_order_return_items_order_item_id" ON "order_return_items"("order_item_id");

-- CreateIndex
CREATE UNIQUE INDEX "uk_order_return_items_return_item" ON "order_return_items"("return_id", "order_item_id");

-- CreateIndex
CREATE INDEX "idx_stock_movements_product_id" ON "stock_movements"("product_id", "created_at");

-- CreateIndex
CREATE INDEX "idx_analytics_events_type_created_at" ON "analytics_events"("event_type", "created_at");

-- CreateIndex
CREATE INDEX "idx_analytics_events_product_id" ON "analytics_events"("product_id");

-- CreateIndex
CREATE INDEX "idx_notifications_order_id" ON "notifications"("order_id");

-- CreateIndex
CREATE INDEX "idx_notifications_user_id" ON "notifications"("user_id");

-- CreateIndex
CREATE INDEX "idx_notifications_created_at" ON "notifications"("created_at");

-- CreateIndex
CREATE UNIQUE INDEX "uk_password_reset_tokens_token_hash" ON "password_reset_tokens"("token_hash");

-- CreateIndex
CREATE INDEX "idx_password_reset_tokens_user_id" ON "password_reset_tokens"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "uk_seller_applications_reference" ON "seller_applications"("reference");

-- CreateIndex
CREATE INDEX "idx_seller_applications_status" ON "seller_applications"("status", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "uk_support_messages_ticket_number" ON "support_messages"("ticket_number");

-- CreateIndex
CREATE INDEX "idx_support_messages_status" ON "support_messages"("status", "created_at");

-- CreateIndex
CREATE INDEX "idx_order_items_product_id" ON "order_items"("product_id");

-- CreateIndex
CREATE INDEX "idx_orders_customer_email" ON "orders"("customer_email");

-- CreateIndex
CREATE INDEX "idx_orders_fulfilment_status" ON "orders"("fulfilment_status");

-- CreateIndex
CREATE INDEX "idx_orders_paid_at" ON "orders"("paid_at");

-- CreateIndex
CREATE INDEX "idx_parent_products_subcategory_id" ON "parent_products"("subcategory_id");

-- CreateIndex
CREATE INDEX "idx_product_categories_parent_id" ON "product_categories"("parent_id");

-- AddForeignKey
ALTER TABLE "product_categories" ADD CONSTRAINT "fk_product_categories_parent" FOREIGN KEY ("parent_id") REFERENCES "product_categories"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "parent_products" ADD CONSTRAINT "fk_parent_products_subcategory" FOREIGN KEY ("subcategory_id") REFERENCES "product_categories"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "order_events" ADD CONSTRAINT "fk_order_events_order" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "shipments" ADD CONSTRAINT "fk_shipments_order" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "shipment_events" ADD CONSTRAINT "fk_shipment_events_shipment" FOREIGN KEY ("shipment_id") REFERENCES "shipments"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "order_returns" ADD CONSTRAINT "fk_order_returns_order" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "order_return_items" ADD CONSTRAINT "fk_order_return_items_return" FOREIGN KEY ("return_id") REFERENCES "order_returns"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "order_return_items" ADD CONSTRAINT "fk_order_return_items_order_item" FOREIGN KEY ("order_item_id") REFERENCES "order_items"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "stock_movements" ADD CONSTRAINT "fk_stock_movements_product" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "notifications" ADD CONSTRAINT "fk_notifications_order" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "notifications" ADD CONSTRAINT "fk_notifications_user" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "password_reset_tokens" ADD CONSTRAINT "fk_password_reset_tokens_user" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;


-- ── SQL-only constraints (Prisma can't express partial indexes) ────────────

-- Guest checkout replay protection: the same browser retrying with the same
-- Idempotency-Key and email gets the same order (signed-in orders use
-- uniq_orders_user_idempotency_key).
CREATE UNIQUE INDEX "uniq_orders_guest_idempotency_key"
    ON "orders" ("customer_email", "idempotency_key")
    WHERE "user_id" IS NULL AND "idempotency_key" IS NOT NULL;

-- Product URLs (NFR-04): unique when set; most imported rows start without one.
CREATE UNIQUE INDEX "uniq_products_url_slug"
    ON "products" ("url_slug")
    WHERE "url_slug" IS NOT NULL;

-- ── Frozen taxonomy (FR-ST-02, FR-IM-04) ───────────────────────────────────
-- Departments and their sections, as in the designs. Idempotent: an existing
-- slug is kept (and only gains a code/position it lacks); sections attach to
-- the department with that slug whether it was created here or before.

INSERT INTO "product_categories" ("id", "created_at", "updated_at", "deleted", "name", "slug", "description", "position", "code")
VALUES
    (gen_random_uuid(), now(), now(), false, 'Clothing',               'clothing',         NULL, 0, 'CL'),
    (gen_random_uuid(), now(), now(), false, 'Electronics',            'electronics',      NULL, 1, 'EL'),
    (gen_random_uuid(), now(), now(), false, 'Home & Kitchen',         'home-kitchen',     NULL, 2, 'HK'),
    (gen_random_uuid(), now(), now(), false, 'Grocery',                'grocery',          NULL, 3, 'GR'),
    (gen_random_uuid(), now(), now(), false, 'Beauty & Personal Care', 'beauty',           NULL, 4, 'BP'),
    (gen_random_uuid(), now(), now(), false, 'Books & Stationery',     'books-stationery', NULL, 5, 'BS'),
    (gen_random_uuid(), now(), now(), false, 'Toys & Kids',            'toys-kids',        NULL, 6, 'TK'),
    (gen_random_uuid(), now(), now(), false, 'Sports & Fitness',       'sports-fitness',   NULL, 7, 'SF'),
    (gen_random_uuid(), now(), now(), false, 'Lifestyle',              'lifestyle',        NULL, 8, 'LS')
ON CONFLICT ("slug") DO NOTHING;

UPDATE "product_categories" AS c
SET "code" = COALESCE(c."code", v.code),
    "position" = CASE WHEN c."code" IS NULL THEN v.position ELSE c."position" END
FROM (VALUES
    ('clothing', 'CL', 0), ('electronics', 'EL', 1), ('home-kitchen', 'HK', 2),
    ('grocery', 'GR', 3), ('beauty', 'BP', 4), ('books-stationery', 'BS', 5),
    ('toys-kids', 'TK', 6), ('sports-fitness', 'SF', 7), ('lifestyle', 'LS', 8)
) AS v(slug, code, position)
WHERE c."slug" = v.slug AND c."parent_id" IS NULL;

INSERT INTO "product_categories" ("id", "created_at", "updated_at", "deleted", "name", "slug", "description", "parent_id", "position", "code")
SELECT gen_random_uuid(), now(), now(), false, v.name, v.slug, NULL, d."id", v.position, v.code
FROM (VALUES
    ('clothing',         'Women',               'clothing-women',              0, 'WMN'),
    ('clothing',         'Men',                 'clothing-men',                1, 'MEN'),
    ('electronics',      'Audio & smart tech',  'electronics-audio-smart-tech', 0, 'AUD'),
    ('electronics',      'Computer & phone',    'electronics-computer-phone',  1, 'CMP'),
    ('home-kitchen',     'Kitchen',             'home-kitchen-kitchen',        0, 'KIT'),
    ('home-kitchen',     'Home',                'home-kitchen-home',           1, 'HOM'),
    ('grocery',          'Pantry',              'grocery-pantry',              0, 'PAN'),
    ('grocery',          'Drinks & treats',     'grocery-drinks-treats',       1, 'DRK'),
    ('beauty',           'Beauty',              'beauty-beauty',               0, 'BTY'),
    ('beauty',           'Personal care',       'beauty-personal-care',        1, 'PCR'),
    ('books-stationery', 'Books',               'books-stationery-books',      0, 'BOK'),
    ('books-stationery', 'Stationery',          'books-stationery-stationery', 1, 'STN'),
    ('toys-kids',        'Toys',                'toys-kids-toys',              0, 'TOY'),
    ('toys-kids',        'Kids & baby',         'toys-kids-kids-baby',         1, 'KDB'),
    ('sports-fitness',   'Fitness',             'sports-fitness-fitness',      0, 'FIT'),
    ('sports-fitness',   'Outdoors',            'sports-fitness-outdoors',     1, 'OUT'),
    ('lifestyle',        'Gifts',               'lifestyle-gifts',             0, 'GFT'),
    ('lifestyle',        'Everyday',            'lifestyle-everyday',          1, 'EVD')
) AS v(dept_slug, name, slug, position, code)
JOIN "product_categories" d ON d."slug" = v.dept_slug
ON CONFLICT ("slug") DO NOTHING;
