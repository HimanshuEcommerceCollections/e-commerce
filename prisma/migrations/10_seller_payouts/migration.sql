-- Seller payouts: each Friday the delivered orders of the week before (no
-- return open) are closed into one payout per seller. The payments team sends
-- the money and marks the payout paid. An order is paid out at most once per
-- seller (uk_seller_payout_items_merchant_order).

-- CreateTable
CREATE TABLE "seller_payouts" (
    "id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "reference" VARCHAR(20) NOT NULL,
    "merchant_id" UUID NOT NULL,
    "period_from" TIMESTAMPTZ(6) NOT NULL,
    "period_to" TIMESTAMPTZ(6) NOT NULL,
    "scheduled_for" DATE NOT NULL,
    "status" VARCHAR(20) NOT NULL,
    "orders" INTEGER NOT NULL,
    "sales" DECIMAL(12,2) NOT NULL,
    "commission" DECIMAL(12,2) NOT NULL,
    "refunds" DECIMAL(12,2) NOT NULL,
    "net" DECIMAL(12,2) NOT NULL,
    "paid_at" TIMESTAMPTZ(6),
    "paid_by" VARCHAR(255),

    CONSTRAINT "seller_payouts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "seller_payout_items" (
    "id" UUID NOT NULL,
    "payout_id" UUID NOT NULL,
    "merchant_id" UUID NOT NULL,
    "order_id" UUID NOT NULL,
    "delivered_at" TIMESTAMPTZ(6) NOT NULL,
    "sales" DECIMAL(12,2) NOT NULL,
    "commission" DECIMAL(12,2) NOT NULL,
    "refunds" DECIMAL(12,2) NOT NULL,
    "net" DECIMAL(12,2) NOT NULL,

    CONSTRAINT "seller_payout_items_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "uk_seller_payouts_reference" ON "seller_payouts"("reference");
CREATE INDEX "idx_seller_payouts_merchant" ON "seller_payouts"("merchant_id", "scheduled_for");
CREATE INDEX "idx_seller_payouts_status" ON "seller_payouts"("status", "scheduled_for");
CREATE UNIQUE INDEX "uk_seller_payout_items_merchant_order" ON "seller_payout_items"("merchant_id", "order_id");
CREATE INDEX "idx_seller_payout_items_payout" ON "seller_payout_items"("payout_id");

-- AddForeignKey
ALTER TABLE "seller_payouts" ADD CONSTRAINT "fk_seller_payouts_merchant" FOREIGN KEY ("merchant_id") REFERENCES "users"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;
ALTER TABLE "seller_payout_items" ADD CONSTRAINT "fk_seller_payout_items_payout" FOREIGN KEY ("payout_id") REFERENCES "seller_payouts"("id") ON DELETE CASCADE ON UPDATE NO ACTION;
ALTER TABLE "seller_payout_items" ADD CONSTRAINT "fk_seller_payout_items_order" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;
