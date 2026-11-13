-- Vendor integrations (Gooten print on demand): which catalog products a
-- vendor fulfils, and each order handed to a vendor.

-- CreateTable
CREATE TABLE "vendor_product_links" (
    "id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "vendor" VARCHAR(20) NOT NULL,
    "vendor_product_id" VARCHAR(100) NOT NULL,
    "vendor_name" VARCHAR(255) NOT NULL,
    "parent_product_id" UUID NOT NULL,
    "sku_map" JSONB NOT NULL DEFAULT '{}',
    "print_file_url" VARCHAR(2048),
    "markup_percent" DECIMAL(6,2) NOT NULL,
    "imported_by" VARCHAR(255),

    CONSTRAINT "vendor_product_links_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "vendor_orders" (
    "id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "vendor" VARCHAR(20) NOT NULL,
    "order_id" UUID NOT NULL,
    "vendor_order_id" VARCHAR(100),
    "status" VARCHAR(60) NOT NULL,
    "test_mode" BOOLEAN NOT NULL,
    "ship_method" VARCHAR(20) NOT NULL,
    "request" JSONB NOT NULL DEFAULT '{}',
    "response" JSONB,
    "error" VARCHAR(2000),
    "submitted_by" VARCHAR(255),

    CONSTRAINT "vendor_orders_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "uk_vendor_product_links_parent" ON "vendor_product_links"("parent_product_id");

-- CreateIndex
CREATE INDEX "idx_vendor_product_links_vendor_product" ON "vendor_product_links"("vendor", "vendor_product_id");

-- CreateIndex
CREATE INDEX "idx_vendor_orders_order" ON "vendor_orders"("order_id");

-- CreateIndex
CREATE INDEX "idx_vendor_orders_vendor_created" ON "vendor_orders"("vendor", "created_at");

-- AddForeignKey
ALTER TABLE "vendor_product_links" ADD CONSTRAINT "fk_vendor_product_links_parent" FOREIGN KEY ("parent_product_id") REFERENCES "parent_products"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "vendor_orders" ADD CONSTRAINT "fk_vendor_orders_order" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

