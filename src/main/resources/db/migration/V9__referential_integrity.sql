-- ============================================================================
-- V9 — Foreign keys for live cross-module references.
--
-- The module-decoupling rule bans JPA relations across modules, not schema
-- constraints: carts/user_addresses/orders reference live users, and
-- cart_items reference live products, so the database should refuse orphans.
-- order_items stays deliberately FK-less to users/products — its columns are
-- historical snapshots.
--
-- ON DELETE RESTRICT everywhere: users and products are soft-deleted, never
-- hard-deleted, so a blocked hard delete is a bug surfacing — not a workflow.
--
-- Orphans (rows whose referent never existed or was hard-deleted out-of-band)
-- are removed first. ADD CONSTRAINT ... NOT VALID + VALIDATE is used for its
-- restart-friendliness; note that because Flyway runs this script in a single
-- transaction, the ADD locks are held until commit anyway — writes to these
-- tables block for the duration of the migration. Run it in a quiet window.
-- ============================================================================

-- ── Orphan cleanup ───────────────────────────────────────────────────────────

DELETE FROM cart_items ci
WHERE NOT EXISTS (SELECT 1 FROM products p WHERE p.id = ci.product_id);

DELETE FROM cart_items ci
WHERE NOT EXISTS (SELECT 1 FROM carts c WHERE c.id = ci.cart_id);

-- Items of carts about to be deleted as orphans must go first, or
-- fk_cart_items_cart (V1) aborts the carts delete below.
DELETE FROM cart_items ci
WHERE EXISTS (
    SELECT 1 FROM carts c
    WHERE c.id = ci.cart_id
      AND NOT EXISTS (SELECT 1 FROM users u WHERE u.id = c.user_id)
);

DELETE FROM carts c
WHERE NOT EXISTS (SELECT 1 FROM users u WHERE u.id = c.user_id);

DELETE FROM user_addresses a
WHERE NOT EXISTS (SELECT 1 FROM users u WHERE u.id = a.user_id);

-- Orders are financial records; an order whose user_id matches no users row is
-- unreachable garbage (every order is created from an authenticated user).
DELETE FROM order_items oi
WHERE EXISTS (
    SELECT 1 FROM orders o
    WHERE o.id = oi.order_id
      AND NOT EXISTS (SELECT 1 FROM users u WHERE u.id = o.user_id)
);
DELETE FROM orders o
WHERE NOT EXISTS (SELECT 1 FROM users u WHERE u.id = o.user_id);

-- ── Foreign keys ─────────────────────────────────────────────────────────────

ALTER TABLE carts
    ADD CONSTRAINT fk_carts_user
    FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE RESTRICT NOT VALID;
ALTER TABLE carts VALIDATE CONSTRAINT fk_carts_user;

ALTER TABLE cart_items
    ADD CONSTRAINT fk_cart_items_product
    FOREIGN KEY (product_id) REFERENCES products (id) ON DELETE RESTRICT NOT VALID;
ALTER TABLE cart_items VALIDATE CONSTRAINT fk_cart_items_product;

ALTER TABLE user_addresses
    ADD CONSTRAINT fk_user_addresses_user
    FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE RESTRICT NOT VALID;
ALTER TABLE user_addresses VALIDATE CONSTRAINT fk_user_addresses_user;

ALTER TABLE orders
    ADD CONSTRAINT fk_orders_user
    FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE RESTRICT NOT VALID;
ALTER TABLE orders VALIDATE CONSTRAINT fk_orders_user;
