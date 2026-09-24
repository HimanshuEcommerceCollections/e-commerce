-- Column defaults for Prisma's @default() fields. Additive only: the Java
-- server (Hibernate ddl-auto=validate) ignores defaults, so both servers can
-- share a database during the switch-over.

-- AlterTable
ALTER TABLE "cart_items" ALTER COLUMN "created_at" SET DEFAULT CURRENT_TIMESTAMP,
ALTER COLUMN "deleted" SET DEFAULT false;

-- AlterTable
ALTER TABLE "carts" ALTER COLUMN "created_at" SET DEFAULT CURRENT_TIMESTAMP,
ALTER COLUMN "deleted" SET DEFAULT false;

-- AlterTable
ALTER TABLE "order_items" ALTER COLUMN "created_at" SET DEFAULT CURRENT_TIMESTAMP,
ALTER COLUMN "deleted" SET DEFAULT false;

-- AlterTable
ALTER TABLE "orders" ALTER COLUMN "created_at" SET DEFAULT CURRENT_TIMESTAMP,
ALTER COLUMN "deleted" SET DEFAULT false;

-- AlterTable
ALTER TABLE "parent_products" ALTER COLUMN "created_at" SET DEFAULT CURRENT_TIMESTAMP,
ALTER COLUMN "deleted" SET DEFAULT false;

-- AlterTable
ALTER TABLE "product_categories" ALTER COLUMN "created_at" SET DEFAULT CURRENT_TIMESTAMP,
ALTER COLUMN "deleted" SET DEFAULT false;

-- AlterTable
ALTER TABLE "product_images" ALTER COLUMN "created_at" SET DEFAULT CURRENT_TIMESTAMP,
ALTER COLUMN "deleted" SET DEFAULT false,
ALTER COLUMN "is_primary" SET DEFAULT false;

-- AlterTable
ALTER TABLE "products" ALTER COLUMN "created_at" SET DEFAULT CURRENT_TIMESTAMP,
ALTER COLUMN "deleted" SET DEFAULT false;

-- AlterTable
ALTER TABLE "user_addresses" ALTER COLUMN "created_at" SET DEFAULT CURRENT_TIMESTAMP,
ALTER COLUMN "deleted" SET DEFAULT false,
ALTER COLUMN "is_default" SET DEFAULT false;

-- AlterTable
ALTER TABLE "users" ALTER COLUMN "created_at" SET DEFAULT CURRENT_TIMESTAMP,
ALTER COLUMN "deleted" SET DEFAULT false,
ALTER COLUMN "enabled" SET DEFAULT true,
ALTER COLUMN "account_non_locked" SET DEFAULT true;

