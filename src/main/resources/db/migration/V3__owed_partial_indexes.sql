-- ============================================================================
-- V3 — Partial unique indexes that JPA cannot express (WHERE clauses).
--
-- These enforce, at the database level, two single-row invariants the services
-- have been maintaining in application code:
--   * at most one DEFAULT address per (live) user
--   * at most one PRIMARY image per (live) product
--
-- If an existing database somehow holds duplicates, this migration will fail —
-- deduplicate those rows first, then re-run. On a fresh database there is no
-- data to conflict.
-- ============================================================================

CREATE UNIQUE INDEX uniq_user_addresses_default
    ON user_addresses (user_id)
    WHERE is_default = true AND deleted = false;

CREATE UNIQUE INDEX uniq_product_images_primary
    ON product_images (product_id)
    WHERE is_primary = true AND deleted = false;
