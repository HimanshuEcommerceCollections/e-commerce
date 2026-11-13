-- Catalog audit log: every change to sellers, products and stock, with who
-- made it, when, where it came from and the previous value. Records can't be
-- edited or deleted (trigger below). Deliberately without FKs: events outlive
-- the users, products and submissions they mention.

-- CreateTable
CREATE TABLE "audit_events" (
    "id" UUID NOT NULL,
    "seq" BIGSERIAL NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "action" VARCHAR(60) NOT NULL,
    "category" VARCHAR(20) NOT NULL,
    "actor_id" UUID,
    "actor_email" VARCHAR(255),
    "actor_name" VARCHAR(200),
    "actor_role" VARCHAR(20),
    "actor_type" VARCHAR(10) NOT NULL,
    "source" VARCHAR(100) NOT NULL,
    "entity_type" VARCHAR(30) NOT NULL,
    "entity_id" VARCHAR(100),
    "entity_code" VARCHAR(255),
    "entity_label" VARCHAR(255),
    "seller_id" UUID,
    "seller_name" VARCHAR(200),
    "summary" VARCHAR(500) NOT NULL,
    "before_value" VARCHAR(500),
    "after_value" VARCHAR(500),
    "note" VARCHAR(2000),
    "alert" VARCHAR(255),
    "details" JSONB NOT NULL DEFAULT '{}',

    CONSTRAINT "audit_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "uk_audit_events_seq" ON "audit_events"("seq");

-- CreateIndex
CREATE INDEX "idx_audit_events_created" ON "audit_events"("created_at" DESC);

-- CreateIndex
CREATE INDEX "idx_audit_events_entity" ON "audit_events"("entity_type", "entity_id", "created_at");

-- CreateIndex
CREATE INDEX "idx_audit_events_entity_code" ON "audit_events"("entity_code", "created_at");

-- CreateIndex
CREATE INDEX "idx_audit_events_actor" ON "audit_events"("actor_id", "created_at");

-- CreateIndex
CREATE INDEX "idx_audit_events_action" ON "audit_events"("action", "created_at");

-- CreateIndex
CREATE INDEX "idx_audit_events_category" ON "audit_events"("category", "created_at");

-- CreateIndex
CREATE INDEX "idx_audit_events_seller" ON "audit_events"("seller_id", "created_at");

-- Append-only: rows can be added, never changed or removed.
CREATE OR REPLACE FUNCTION audit_events_immutable() RETURNS trigger AS $$
BEGIN
    RAISE EXCEPTION 'audit_events is append-only (% rejected)', TG_OP;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_audit_events_immutable
    BEFORE UPDATE OR DELETE ON "audit_events"
    FOR EACH ROW EXECUTE FUNCTION audit_events_immutable();
