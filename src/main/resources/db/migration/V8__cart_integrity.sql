-- ============================================================================
-- V8 — Cart uniqueness: one live cart per user, one live line per product.
--
-- CartService's check-then-insert paths have been racing in production
-- (getOrCreateCart / addItem), so duplicate live carts and duplicate live
-- cart_items rows may already exist — and CREATE UNIQUE INDEX fails on
-- duplicates (see V3's note). This migration therefore dedupes the live data
-- first, then adds the partial unique indexes that make the races impossible.
--
-- Dedupe policy:
--   * carts: keep the newest live cart per user; re-point the losers' live
--     items at it; soft-delete the losers.
--   * cart_items: keep the most recently updated live row per (cart, product)
--     with the summed quantity (capped at the request-level max of 999);
--     soft-delete the rest.
-- Soft-deleted rows may keep duplicates — the indexes only cover deleted=false.
-- ============================================================================

-- Hold off concurrent cart writes from a still-running old app instance (which
-- has the very races being fixed): without this, a duplicate inserted between
-- the dedupe statements and the index build would abort the migration.
LOCK TABLE carts IN SHARE MODE;
LOCK TABLE cart_items IN SHARE MODE;

-- ── 1. Merge duplicate live carts per user ──────────────────────────────────

-- Re-point live items of non-keeper carts at the keeper (newest) cart.
WITH ranked AS (
    SELECT id, user_id,
           ROW_NUMBER() OVER (PARTITION BY user_id ORDER BY created_at DESC, id DESC) AS rn
    FROM carts
    WHERE deleted = false
),
keepers AS (SELECT user_id, id FROM ranked WHERE rn = 1),
losers  AS (SELECT user_id, id FROM ranked WHERE rn > 1)
UPDATE cart_items ci
SET cart_id = k.id, updated_at = now()
FROM losers l
JOIN keepers k ON k.user_id = l.user_id
WHERE ci.cart_id = l.id
  AND ci.deleted = false;

-- Soft-delete the loser carts.
WITH ranked AS (
    SELECT id,
           ROW_NUMBER() OVER (PARTITION BY user_id ORDER BY created_at DESC, id DESC) AS rn
    FROM carts
    WHERE deleted = false
)
UPDATE carts
SET deleted = true, updated_at = now()
WHERE id IN (SELECT id FROM ranked WHERE rn > 1);

-- ── 2. Collapse duplicate live lines per (cart, product) ────────────────────

-- Keeper gets the summed quantity (capped at 999, the per-request max).
WITH ranked AS (
    SELECT id,
           ROW_NUMBER() OVER (PARTITION BY cart_id, product_id ORDER BY updated_at DESC, id DESC) AS rn,
           SUM(quantity)  OVER (PARTITION BY cart_id, product_id) AS total_qty
    FROM cart_items
    WHERE deleted = false
)
UPDATE cart_items ci
SET quantity = LEAST(r.total_qty, 999), updated_at = now()
FROM ranked r
WHERE ci.id = r.id AND r.rn = 1 AND ci.quantity <> LEAST(r.total_qty, 999);

WITH ranked AS (
    SELECT id,
           ROW_NUMBER() OVER (PARTITION BY cart_id, product_id ORDER BY updated_at DESC, id DESC) AS rn
    FROM cart_items
    WHERE deleted = false
)
UPDATE cart_items
SET deleted = true, updated_at = now()
WHERE id IN (SELECT id FROM ranked WHERE rn > 1);

-- ── 3. The invariants, enforced at the database level ───────────────────────

CREATE UNIQUE INDEX uniq_carts_user_live
    ON carts (user_id)
    WHERE deleted = false;

CREATE UNIQUE INDEX uniq_cart_items_cart_product_live
    ON cart_items (cart_id, product_id)
    WHERE deleted = false;
