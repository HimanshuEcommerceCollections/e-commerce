-- Customer account and storefront gaps from the design review: promotions,
-- reviews and ratings, saved items, store credit and gift cards, saved payment
-- methods, sessions, 2-step verification, notification preferences, data
-- export, payment/billing/savings snapshots on orders, return logistics, and
-- staff handling of support messages and seller applications. Additive only.

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "birthday" VARCHAR(5),
ADD COLUMN     "deletion_requested_at" TIMESTAMPTZ(6),
ADD COLUMN     "store_credit_balance" DECIMAL(12,2) NOT NULL DEFAULT 0,
ADD COLUMN     "stripe_customer_id" VARCHAR(255),
ADD COLUMN     "two_factor_enabled" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "two_factor_phone" VARCHAR(20);

-- AlterTable
ALTER TABLE "parent_products" ADD COLUMN     "rating_avg" DECIMAL(3,2) NOT NULL DEFAULT 0,
ADD COLUMN     "rating_count" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "orders" ADD COLUMN     "bill_address_line1" VARCHAR(255),
ADD COLUMN     "bill_postal_code" VARCHAR(20),
ADD COLUMN     "bill_same_as_shipping" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "card_brand" VARCHAR(20),
ADD COLUMN     "card_last4" VARCHAR(4),
ADD COLUMN     "payment_method_type" VARCHAR(20),
ADD COLUMN     "promo_code" VARCHAR(40),
ADD COLUMN     "promotion_id" UUID,
ADD COLUMN     "savings_total" DECIMAL(12,2) NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "order_items" ADD COLUMN     "mrp" DECIMAL(12,2);

-- AlterTable
ALTER TABLE "order_returns" ADD COLUMN     "dropoff_by" TIMESTAMPTZ(6),
ADD COLUMN     "dropoff_code" VARCHAR(40),
ADD COLUMN     "dropped_off_at" TIMESTAMPTZ(6),
ADD COLUMN     "pickup_date" DATE,
ADD COLUMN     "pickup_window" VARCHAR(40),
ADD COLUMN     "refund_to" VARCHAR(20) NOT NULL DEFAULT 'ORIGINAL';

-- AlterTable
ALTER TABLE "seller_applications" ADD COLUMN     "admin_note" VARCHAR(2000),
ADD COLUMN     "consent_at" TIMESTAMPTZ(6),
ADD COLUMN     "handled_by" VARCHAR(255),
ADD COLUMN     "updated_at" TIMESTAMPTZ(6);

-- AlterTable
ALTER TABLE "support_messages" ADD COLUMN     "admin_note" VARCHAR(2000),
ADD COLUMN     "handled_by" VARCHAR(255),
ADD COLUMN     "updated_at" TIMESTAMPTZ(6);

-- CreateTable
CREATE TABLE "promotions" (
    "id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "code" VARCHAR(40) NOT NULL,
    "description" VARCHAR(255) NOT NULL,
    "type" VARCHAR(20) NOT NULL,
    "value" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "min_subtotal" DECIMAL(12,2),
    "starts_at" TIMESTAMPTZ(6),
    "ends_at" TIMESTAMPTZ(6),
    "usage_limit" INTEGER,
    "per_customer_limit" INTEGER,
    "first_order_only" BOOLEAN NOT NULL DEFAULT false,
    "active" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "promotions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "product_reviews" (
    "id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "deleted" BOOLEAN NOT NULL DEFAULT false,
    "parent_id" UUID NOT NULL,
    "product_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "order_item_id" UUID,
    "rating" SMALLINT NOT NULL,
    "title" VARCHAR(80) NOT NULL,
    "body" VARCHAR(2000) NOT NULL,
    "recommend" BOOLEAN NOT NULL DEFAULT true,
    "status" VARCHAR(20) NOT NULL,
    "published_at" TIMESTAMPTZ(6),
    "moderator_note" VARCHAR(1000),

    CONSTRAINT "product_reviews_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "saved_items" (
    "id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "user_id" UUID NOT NULL,
    "product_id" UUID NOT NULL,
    "price_at_save" DECIMAL(12,2) NOT NULL,

    CONSTRAINT "saved_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notification_preferences" (
    "user_id" UUID NOT NULL,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "new_arrivals" BOOLEAN NOT NULL DEFAULT false,
    "price_drops" BOOLEAN NOT NULL DEFAULT true,
    "back_in_stock" BOOLEAN NOT NULL DEFAULT true,
    "review_reminders" BOOLEAN NOT NULL DEFAULT true,
    "sms_delivery" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "notification_preferences_pkey" PRIMARY KEY ("user_id")
);

-- CreateTable
CREATE TABLE "gift_cards" (
    "id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "code_hash" VARCHAR(64) NOT NULL,
    "last4" VARCHAR(4) NOT NULL,
    "pin_hash" VARCHAR(255) NOT NULL,
    "initial_amount" DECIMAL(12,2) NOT NULL,
    "currency" VARCHAR(3) NOT NULL,
    "status" VARCHAR(20) NOT NULL,
    "redeemed_by_user_id" UUID,
    "redeemed_at" TIMESTAMPTZ(6),
    "expires_at" TIMESTAMPTZ(6),
    "created_by" VARCHAR(255),

    CONSTRAINT "gift_cards_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "store_credit_entries" (
    "id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "user_id" UUID NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "balance_after" DECIMAL(12,2) NOT NULL,
    "type" VARCHAR(20) NOT NULL,
    "description" VARCHAR(255) NOT NULL,
    "order_id" UUID,
    "return_id" UUID,
    "gift_card_id" UUID,
    "created_by" VARCHAR(255),

    CONSTRAINT "store_credit_entries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "saved_payment_methods" (
    "id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deleted" BOOLEAN NOT NULL DEFAULT false,
    "user_id" UUID NOT NULL,
    "provider" VARCHAR(20) NOT NULL,
    "provider_payment_method_id" VARCHAR(255) NOT NULL,
    "type" VARCHAR(20) NOT NULL,
    "brand" VARCHAR(20),
    "last4" VARCHAR(4),
    "exp_month" INTEGER,
    "exp_year" INTEGER,
    "holder_name" VARCHAR(200),
    "email" VARCHAR(255),
    "is_default" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "saved_payment_methods_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_sessions" (
    "id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "user_id" UUID NOT NULL,
    "user_agent" VARCHAR(255),
    "label" VARCHAR(100) NOT NULL,
    "device_type" VARCHAR(20) NOT NULL,
    "ip" VARCHAR(45),
    "last_seen_at" TIMESTAMPTZ(6) NOT NULL,
    "revoked_at" TIMESTAMPTZ(6),

    CONSTRAINT "user_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "otp_challenges" (
    "id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "user_id" UUID NOT NULL,
    "purpose" VARCHAR(20) NOT NULL,
    "phone" VARCHAR(20) NOT NULL,
    "code_hash" VARCHAR(64) NOT NULL,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "consumed_at" TIMESTAMPTZ(6),

    CONSTRAINT "otp_challenges_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "data_export_requests" (
    "id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "user_id" UUID NOT NULL,
    "status" VARCHAR(20) NOT NULL,
    "completed_at" TIMESTAMPTZ(6),
    "expires_at" TIMESTAMPTZ(6),
    "download_token_hash" VARCHAR(64),
    "payload" JSONB,

    CONSTRAINT "data_export_requests_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "uk_promotions_code" ON "promotions"("code");

-- CreateIndex
CREATE INDEX "idx_product_reviews_parent" ON "product_reviews"("parent_id", "status", "created_at");

-- CreateIndex
CREATE INDEX "idx_product_reviews_user" ON "product_reviews"("user_id");

-- CreateIndex
CREATE INDEX "idx_product_reviews_status" ON "product_reviews"("status", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "uk_saved_items_user_product" ON "saved_items"("user_id", "product_id");

-- CreateIndex
CREATE UNIQUE INDEX "uk_gift_cards_code_hash" ON "gift_cards"("code_hash");

-- CreateIndex
CREATE INDEX "idx_store_credit_entries_user" ON "store_credit_entries"("user_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "uk_saved_payment_methods_provider_id" ON "saved_payment_methods"("provider_payment_method_id");

-- CreateIndex
CREATE INDEX "idx_saved_payment_methods_user" ON "saved_payment_methods"("user_id", "deleted");

-- CreateIndex
CREATE INDEX "idx_user_sessions_user" ON "user_sessions"("user_id", "revoked_at");

-- CreateIndex
CREATE INDEX "idx_otp_challenges_user" ON "otp_challenges"("user_id", "created_at");

-- CreateIndex
CREATE INDEX "idx_data_export_requests_user" ON "data_export_requests"("user_id", "created_at");

-- CreateIndex
CREATE INDEX "idx_orders_promotion_id" ON "orders"("promotion_id");

-- AddForeignKey
ALTER TABLE "orders" ADD CONSTRAINT "fk_orders_promotion" FOREIGN KEY ("promotion_id") REFERENCES "promotions"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "product_reviews" ADD CONSTRAINT "fk_product_reviews_parent" FOREIGN KEY ("parent_id") REFERENCES "parent_products"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "product_reviews" ADD CONSTRAINT "fk_product_reviews_product" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "product_reviews" ADD CONSTRAINT "fk_product_reviews_user" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "product_reviews" ADD CONSTRAINT "fk_product_reviews_order_item" FOREIGN KEY ("order_item_id") REFERENCES "order_items"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "saved_items" ADD CONSTRAINT "fk_saved_items_user" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "saved_items" ADD CONSTRAINT "fk_saved_items_product" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "notification_preferences" ADD CONSTRAINT "fk_notification_preferences_user" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "store_credit_entries" ADD CONSTRAINT "fk_store_credit_entries_user" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "saved_payment_methods" ADD CONSTRAINT "fk_saved_payment_methods_user" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "user_sessions" ADD CONSTRAINT "fk_user_sessions_user" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "otp_challenges" ADD CONSTRAINT "fk_otp_challenges_user" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "data_export_requests" ADD CONSTRAINT "fk_data_export_requests_user" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;


-- Not expressible in Prisma; keep these when generating later migrations.

-- One live review per customer per product.
CREATE UNIQUE INDEX "uniq_product_reviews_user_parent" ON "product_reviews"("user_id", "parent_id") WHERE NOT "deleted";

-- One default payment method per customer.
CREATE UNIQUE INDEX "uniq_saved_payment_methods_default" ON "saved_payment_methods"("user_id") WHERE "is_default" AND NOT "deleted";

ALTER TABLE "product_reviews" ADD CONSTRAINT "chk_product_reviews_rating" CHECK ("rating" BETWEEN 1 AND 5);
ALTER TABLE "users" ADD CONSTRAINT "chk_users_store_credit_non_negative" CHECK ("store_credit_balance" >= 0);
ALTER TABLE "gift_cards" ADD CONSTRAINT "chk_gift_cards_amount_positive" CHECK ("initial_amount" > 0);
