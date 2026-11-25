-- CRM (designs/crm): customers, suppliers (the sales pipeline), tickets, tasks
-- and activity history for the admin team. Customers are created on first sight
-- from customer accounts; suppliers follow seller applications; help-center
-- messages and seller tickets are copied into crm_tickets by the API.

-- CreateTable
CREATE TABLE "crm_customers" (
    "id" UUID NOT NULL,
    "number" SERIAL NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "user_id" UUID,
    "name" VARCHAR(200),
    "email" VARCHAR(255),
    "phone" VARCHAR(30),
    "owner_id" UUID,
    "tags" TEXT[] DEFAULT ARRAY[]::TEXT[],

    CONSTRAINT "crm_customers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "crm_suppliers" (
    "id" UUID NOT NULL,
    "number" SERIAL NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "company" VARCHAR(200) NOT NULL,
    "contact_name" VARCHAR(200),
    "email" VARCHAR(255),
    "phone" VARCHAR(30),
    "location" VARCHAR(200),
    "category" VARCHAR(120),
    "stage" VARCHAR(12) NOT NULL,
    "stage_changed_at" TIMESTAMPTZ(6) NOT NULL,
    "est_products" INTEGER NOT NULL DEFAULT 0,
    "source" VARCHAR(30) NOT NULL,
    "owner_id" UUID,
    "next_step" VARCHAR(300),
    "next_due" TIMESTAMPTZ(6),
    "lost_reason" VARCHAR(500),
    "user_id" UUID,
    "application_id" UUID,
    "app_stage" VARCHAR(40),

    CONSTRAINT "crm_suppliers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "crm_tickets" (
    "id" UUID NOT NULL,
    "number" SERIAL NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "subject" VARCHAR(200) NOT NULL,
    "category" VARCHAR(30) NOT NULL,
    "priority" VARCHAR(10) NOT NULL,
    "status" VARCHAR(10) NOT NULL,
    "channel" VARCHAR(30) NOT NULL,
    "requester_kind" VARCHAR(10) NOT NULL,
    "customer_id" UUID,
    "supplier_id" UUID,
    "requester_name" VARCHAR(200) NOT NULL,
    "requester_email" VARCHAR(255),
    "owner_id" UUID,
    "sla_due_at" TIMESTAMPTZ(6) NOT NULL,
    "last_message_at" TIMESTAMPTZ(6) NOT NULL,
    "solved_at" TIMESTAMPTZ(6),
    "source" VARCHAR(20) NOT NULL DEFAULT 'STAFF',
    "source_ref" VARCHAR(80),
    "external_ref" VARCHAR(40),
    "synced_at" TIMESTAMPTZ(6),

    CONSTRAINT "crm_tickets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "crm_ticket_messages" (
    "id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ticket_id" UUID NOT NULL,
    "kind" VARCHAR(10) NOT NULL,
    "author_id" UUID,
    "author_name" VARCHAR(200) NOT NULL,
    "body" VARCHAR(5000) NOT NULL,
    "source_ref" VARCHAR(80),

    CONSTRAINT "crm_ticket_messages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "crm_tasks" (
    "id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "title" VARCHAR(300) NOT NULL,
    "owner_id" UUID,
    "due_at" TIMESTAMPTZ(6) NOT NULL,
    "done_at" TIMESTAMPTZ(6),
    "customer_id" UUID,
    "supplier_id" UUID,
    "created_by" UUID,

    CONSTRAINT "crm_tasks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "crm_activities" (
    "id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "kind" VARCHAR(10) NOT NULL,
    "body" VARCHAR(2000) NOT NULL,
    "author_id" UUID,
    "author_name" VARCHAR(200),
    "customer_id" UUID,
    "supplier_id" UUID,

    CONSTRAINT "crm_activities_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "uk_crm_customers_number" ON "crm_customers"("number");

-- CreateIndex
CREATE UNIQUE INDEX "uk_crm_customers_user" ON "crm_customers"("user_id");

-- CreateIndex
CREATE INDEX "idx_crm_customers_owner" ON "crm_customers"("owner_id");

-- CreateIndex
CREATE UNIQUE INDEX "uk_crm_suppliers_number" ON "crm_suppliers"("number");

-- CreateIndex
CREATE UNIQUE INDEX "uk_crm_suppliers_user" ON "crm_suppliers"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "uk_crm_suppliers_application" ON "crm_suppliers"("application_id");

-- CreateIndex
CREATE INDEX "idx_crm_suppliers_stage" ON "crm_suppliers"("stage", "stage_changed_at");

-- CreateIndex
CREATE INDEX "idx_crm_suppliers_owner" ON "crm_suppliers"("owner_id");

-- CreateIndex
CREATE UNIQUE INDEX "uk_crm_tickets_number" ON "crm_tickets"("number");

-- CreateIndex
CREATE INDEX "idx_crm_tickets_status" ON "crm_tickets"("status", "sla_due_at");

-- CreateIndex
CREATE INDEX "idx_crm_tickets_customer" ON "crm_tickets"("customer_id");

-- CreateIndex
CREATE INDEX "idx_crm_tickets_supplier" ON "crm_tickets"("supplier_id");

-- CreateIndex
CREATE INDEX "idx_crm_tickets_owner" ON "crm_tickets"("owner_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "uk_crm_tickets_source" ON "crm_tickets"("source", "source_ref");

-- CreateIndex
CREATE INDEX "idx_crm_ticket_messages_ticket" ON "crm_ticket_messages"("ticket_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "uk_crm_ticket_messages_source" ON "crm_ticket_messages"("ticket_id", "source_ref");

-- CreateIndex
CREATE INDEX "idx_crm_tasks_owner" ON "crm_tasks"("owner_id", "done_at", "due_at");

-- CreateIndex
CREATE INDEX "idx_crm_tasks_customer" ON "crm_tasks"("customer_id");

-- CreateIndex
CREATE INDEX "idx_crm_tasks_supplier" ON "crm_tasks"("supplier_id");

-- CreateIndex
CREATE INDEX "idx_crm_activities_customer" ON "crm_activities"("customer_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "idx_crm_activities_supplier" ON "crm_activities"("supplier_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "idx_crm_activities_created" ON "crm_activities"("created_at" DESC);

-- AddForeignKey
ALTER TABLE "crm_customers" ADD CONSTRAINT "fk_crm_customers_user" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "crm_suppliers" ADD CONSTRAINT "fk_crm_suppliers_user" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "crm_suppliers" ADD CONSTRAINT "fk_crm_suppliers_application" FOREIGN KEY ("application_id") REFERENCES "seller_applications"("id") ON DELETE SET NULL ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "crm_tickets" ADD CONSTRAINT "fk_crm_tickets_customer" FOREIGN KEY ("customer_id") REFERENCES "crm_customers"("id") ON DELETE SET NULL ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "crm_tickets" ADD CONSTRAINT "fk_crm_tickets_supplier" FOREIGN KEY ("supplier_id") REFERENCES "crm_suppliers"("id") ON DELETE SET NULL ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "crm_ticket_messages" ADD CONSTRAINT "fk_crm_ticket_messages_ticket" FOREIGN KEY ("ticket_id") REFERENCES "crm_tickets"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "crm_tasks" ADD CONSTRAINT "fk_crm_tasks_customer" FOREIGN KEY ("customer_id") REFERENCES "crm_customers"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "crm_tasks" ADD CONSTRAINT "fk_crm_tasks_supplier" FOREIGN KEY ("supplier_id") REFERENCES "crm_suppliers"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "crm_activities" ADD CONSTRAINT "fk_crm_activities_customer" FOREIGN KEY ("customer_id") REFERENCES "crm_customers"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "crm_activities" ADD CONSTRAINT "fk_crm_activities_supplier" FOREIGN KEY ("supplier_id") REFERENCES "crm_suppliers"("id") ON DELETE CASCADE ON UPDATE NO ACTION;


-- Display numbers start where the design's samples do: C-1001, S-301, TK-5301.
-- Only this SQL holds these, and the CHECK below.
ALTER SEQUENCE "crm_customers_number_seq" RESTART WITH 1001;
ALTER SEQUENCE "crm_suppliers_number_seq" RESTART WITH 301;
ALTER SEQUENCE "crm_tickets_number_seq" RESTART WITH 5301;

-- A history line belongs to exactly one customer or supplier.
ALTER TABLE "crm_activities" ADD CONSTRAINT "chk_crm_activities_subject" CHECK (num_nonnulls("customer_id", "supplier_id") = 1);
