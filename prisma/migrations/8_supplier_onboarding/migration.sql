-- Supplier onboarding: a seller application becomes a pipeline the catalog
-- team works through (applied → screened → scorecard → documents → approved,
-- or declined / auto-rejected / suspended). Applicants fill the form while
-- signed in, so the draft lives on the row and is tied to their account.
-- Legacy "Sell with us" leads keep their columns and start at APPLIED.

-- AlterTable
ALTER TABLE "seller_applications"
    ADD COLUMN "user_id" UUID,
    ADD COLUMN "stage" VARCHAR(20) NOT NULL DEFAULT 'APPLIED',
    ADD COLUMN "stage_changed_at" TIMESTAMPTZ(6),
    ADD COLUMN "company_name" VARCHAR(200),
    ADD COLUMN "form" JSONB NOT NULL DEFAULT '{}',
    ADD COLUMN "form_step" INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN "submitted_at" TIMESTAMPTZ(6),
    ADD COLUMN "screening" JSONB,
    ADD COLUMN "screened_at" TIMESTAMPTZ(6),
    ADD COLUMN "screening_overridden_by" VARCHAR(255),
    ADD COLUMN "screening_overridden_at" TIMESTAMPTZ(6),
    ADD COLUMN "scores" JSONB NOT NULL DEFAULT '{}',
    ADD COLUMN "score" INTEGER,
    ADD COLUMN "score_override" INTEGER,
    ADD COLUMN "score_override_reason" VARCHAR(500),
    ADD COLUMN "score_note" VARCHAR(2000),
    ADD COLUMN "scored_by" VARCHAR(255),
    ADD COLUMN "scored_at" TIMESTAMPTZ(6),
    ADD COLUMN "decline_reason" VARCHAR(2000),
    ADD COLUMN "declined_by" VARCHAR(255),
    ADD COLUMN "declined_at" TIMESTAMPTZ(6),
    ADD COLUMN "approved_by" VARCHAR(255),
    ADD COLUMN "approved_at" TIMESTAMPTZ(6),
    ADD COLUMN "resale_certificate_issued_at" TIMESTAMPTZ(6),
    ADD COLUMN "suspension_reason" VARCHAR(500),
    ADD COLUMN "suspended_by" VARCHAR(255),
    ADD COLUMN "suspended_at" TIMESTAMPTZ(6),
    ADD COLUMN "reinstated_at" TIMESTAMPTZ(6),
    ADD COLUMN "last_reminder_at" TIMESTAMPTZ(6);

-- Leads already decided in the inbox keep their outcome.
UPDATE "seller_applications" SET "stage" = 'APPROVED', "approved_at" = "updated_at", "approved_by" = "handled_by" WHERE "status" = 'APPROVED';
UPDATE "seller_applications" SET "stage" = 'DECLINED', "declined_at" = "updated_at", "declined_by" = "handled_by" WHERE "status" = 'REJECTED';
UPDATE "seller_applications" SET "submitted_at" = "created_at", "stage_changed_at" = "created_at", "company_name" = "full_name";

-- CreateTable
CREATE TABLE "seller_documents" (
    "id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "user_id" UUID NOT NULL,
    "application_id" UUID,
    "type" VARCHAR(30) NOT NULL,
    "file_name" VARCHAR(255) NOT NULL,
    "content_type" VARCHAR(100) NOT NULL,
    "size_bytes" INTEGER NOT NULL,
    "content" BYTEA NOT NULL,
    "status" VARCHAR(20) NOT NULL DEFAULT 'PENDING',
    "expires_at" DATE,
    "note" VARCHAR(1000),
    "reviewed_by" VARCHAR(255),
    "reviewed_at" TIMESTAMPTZ(6),
    "superseded_at" TIMESTAMPTZ(6),

    CONSTRAINT "seller_documents_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "uk_seller_applications_user" ON "seller_applications"("user_id");
CREATE INDEX "idx_seller_applications_stage" ON "seller_applications"("stage", "submitted_at");
CREATE INDEX "idx_seller_documents_user" ON "seller_documents"("user_id", "type", "created_at");
CREATE INDEX "idx_seller_documents_application" ON "seller_documents"("application_id");

-- One current document per type and supplier (SQL only; Prisma can't express a partial index).
CREATE UNIQUE INDEX "uniq_seller_documents_current" ON "seller_documents"("user_id", "type")
    WHERE "superseded_at" IS NULL;

-- AddForeignKey
ALTER TABLE "seller_applications" ADD CONSTRAINT "fk_seller_applications_user" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;
ALTER TABLE "seller_documents" ADD CONSTRAINT "fk_seller_documents_user" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;
ALTER TABLE "seller_documents" ADD CONSTRAINT "fk_seller_documents_application" FOREIGN KEY ("application_id") REFERENCES "seller_applications"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;
