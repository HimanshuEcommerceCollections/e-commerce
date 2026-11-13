-- API integrations: vendor API connections managed in Admin › Settings ›
-- API integrations. Secrets are sealed with AES-256-GCM by the server
-- (INTEGRATIONS_ENCRYPTION_KEY) before they reach this table.

-- CreateTable
CREATE TABLE "integrations" (
    "id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "slug" VARCHAR(60) NOT NULL,
    "name" VARCHAR(100) NOT NULL,
    "provider" VARCHAR(30) NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "base_url" VARCHAR(2048),
    "settings" JSONB NOT NULL DEFAULT '{}',
    "secrets" TEXT,
    "notes" VARCHAR(2000),
    "created_by" VARCHAR(255),
    "updated_by" VARCHAR(255),

    CONSTRAINT "integrations_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "uk_integrations_slug" ON "integrations"("slug");
