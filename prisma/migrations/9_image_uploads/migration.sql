-- Product image files stored in object storage (Vercel Blob, later R2). One
-- row per upload: product_images rows take their file size from here, and the
-- cleanup job removes files nothing refers to any more (deleted_at is set then).

-- CreateTable
CREATE TABLE "image_uploads" (
    "id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "storage_key" VARCHAR(512) NOT NULL,
    "url" VARCHAR(2048) NOT NULL,
    "content_type" VARCHAR(100) NOT NULL,
    "width" INTEGER NOT NULL,
    "height" INTEGER NOT NULL,
    "file_size_bytes" BIGINT NOT NULL,
    "uploaded_by" UUID,
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "image_uploads_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "uk_image_uploads_storage_key" ON "image_uploads"("storage_key");
CREATE INDEX "idx_image_uploads_created_at" ON "image_uploads"("created_at");
