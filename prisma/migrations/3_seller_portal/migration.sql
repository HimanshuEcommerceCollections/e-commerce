-- Seller portal: every seller change is a submission the catalog team reviews
-- before customers see it. A new product waits as DRAFT SKUs; an edit to a
-- live product waits in `payload` and replaces the live version on approval.

-- CreateTable
CREATE TABLE "product_submissions" (
    "id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "reference" VARCHAR(20) NOT NULL,
    "merchant_id" UUID NOT NULL,
    "parent_product_id" UUID NOT NULL,
    "kind" VARCHAR(20) NOT NULL,
    "status" VARCHAR(20) NOT NULL,
    "source" VARCHAR(10) NOT NULL,
    "file_name" VARCHAR(255),
    "seller_note" VARCHAR(2000),
    "payload" JSONB NOT NULL DEFAULT '{}',
    "reviewer_id" UUID,
    "review_note" VARCHAR(2000),
    "submitted_at" TIMESTAMPTZ(6) NOT NULL,
    "review_started_at" TIMESTAMPTZ(6),
    "decided_at" TIMESTAMPTZ(6),

    CONSTRAINT "product_submissions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "product_submission_events" (
    "id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "submission_id" UUID NOT NULL,
    "status" VARCHAR(20) NOT NULL,
    "actor_id" UUID,
    "actor_email" VARCHAR(255),
    "note" VARCHAR(2000),

    CONSTRAINT "product_submission_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "uk_product_submissions_reference" ON "product_submissions"("reference");
CREATE INDEX "idx_product_submissions_status" ON "product_submissions"("status", "submitted_at");
CREATE INDEX "idx_product_submissions_merchant" ON "product_submissions"("merchant_id", "created_at");
CREATE INDEX "idx_product_submissions_parent" ON "product_submissions"("parent_product_id");
CREATE INDEX "idx_product_submission_events_submission" ON "product_submission_events"("submission_id", "created_at");

-- One open submission per product (SQL only; Prisma can't express a partial index).
CREATE UNIQUE INDEX "uniq_product_submissions_open_parent" ON "product_submissions"("parent_product_id")
    WHERE "status" IN ('SUBMITTED', 'IN_REVIEW', 'CHANGES_REQUESTED');

-- AddForeignKey
ALTER TABLE "product_submissions" ADD CONSTRAINT "fk_product_submissions_merchant" FOREIGN KEY ("merchant_id") REFERENCES "users"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;
ALTER TABLE "product_submissions" ADD CONSTRAINT "fk_product_submissions_parent" FOREIGN KEY ("parent_product_id") REFERENCES "parent_products"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;
ALTER TABLE "product_submissions" ADD CONSTRAINT "fk_product_submissions_reviewer" FOREIGN KEY ("reviewer_id") REFERENCES "users"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;
ALTER TABLE "product_submission_events" ADD CONSTRAINT "fk_product_submission_events_submission" FOREIGN KEY ("submission_id") REFERENCES "product_submissions"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;
