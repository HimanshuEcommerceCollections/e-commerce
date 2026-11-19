-- Seller Help & support (designs/seller/seller-support.html): a seller raises
-- a ticket about a product, order, payout or their account; it is routed to a
-- team by topic, and the seller and staff reply in a thread. Attachments are
-- kept in the database (like seller documents) so only the seller and staff
-- can download them.

-- CreateTable
CREATE TABLE "seller_tickets" (
    "id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "reference" VARCHAR(20) NOT NULL,
    "merchant_id" UUID NOT NULL,
    "topic" VARCHAR(20) NOT NULL,
    "subject" VARCHAR(120) NOT NULL,
    "related_type" VARCHAR(20),
    "related_ref" VARCHAR(80),
    "urgent" BOOLEAN NOT NULL DEFAULT false,
    "status" VARCHAR(20) NOT NULL,
    "team" VARCHAR(60) NOT NULL,
    "assignee_id" UUID,
    "last_message_at" TIMESTAMPTZ(6) NOT NULL,
    "resolved_at" TIMESTAMPTZ(6),

    CONSTRAINT "seller_tickets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "seller_ticket_messages" (
    "id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ticket_id" UUID NOT NULL,
    "author_id" UUID,
    "author_role" VARCHAR(10) NOT NULL,
    "author_name" VARCHAR(200) NOT NULL,
    "body" VARCHAR(5000) NOT NULL,

    CONSTRAINT "seller_ticket_messages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "seller_ticket_attachments" (
    "id" UUID NOT NULL,
    "message_id" UUID NOT NULL,
    "file_name" VARCHAR(255) NOT NULL,
    "content_type" VARCHAR(100) NOT NULL,
    "size_bytes" INTEGER NOT NULL,
    "content" BYTEA NOT NULL,

    CONSTRAINT "seller_ticket_attachments_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "uk_seller_tickets_reference" ON "seller_tickets"("reference");
CREATE INDEX "idx_seller_tickets_merchant" ON "seller_tickets"("merchant_id", "last_message_at" DESC);
CREATE INDEX "idx_seller_tickets_status" ON "seller_tickets"("status", "last_message_at" DESC);
CREATE INDEX "idx_seller_ticket_messages_ticket" ON "seller_ticket_messages"("ticket_id", "created_at");
CREATE INDEX "idx_seller_ticket_attachments_message" ON "seller_ticket_attachments"("message_id");

-- AddForeignKey
ALTER TABLE "seller_tickets" ADD CONSTRAINT "fk_seller_tickets_merchant" FOREIGN KEY ("merchant_id") REFERENCES "users"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;
ALTER TABLE "seller_tickets" ADD CONSTRAINT "fk_seller_tickets_assignee" FOREIGN KEY ("assignee_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE NO ACTION;
ALTER TABLE "seller_ticket_messages" ADD CONSTRAINT "fk_seller_ticket_messages_ticket" FOREIGN KEY ("ticket_id") REFERENCES "seller_tickets"("id") ON DELETE CASCADE ON UPDATE NO ACTION;
ALTER TABLE "seller_ticket_attachments" ADD CONSTRAINT "fk_seller_ticket_attachments_message" FOREIGN KEY ("message_id") REFERENCES "seller_ticket_messages"("id") ON DELETE CASCADE ON UPDATE NO ACTION;
