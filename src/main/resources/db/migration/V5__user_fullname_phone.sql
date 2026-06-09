-- ─────────────────────────────────────────────────────────────────────────────
-- V5 — Collapse first_name/last_name into a single full_name, drop display_name,
--      and add a unique phone_number.
-- Mirrors the updated User entity (Hibernate runs ddl-auto: validate).
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE users ADD COLUMN full_name    varchar(200);
ALTER TABLE users ADD COLUMN phone_number varchar(20);

-- Backfill full_name from the existing first/last names before they are dropped.
UPDATE users SET full_name = btrim(first_name || ' ' || last_name);

ALTER TABLE users ALTER COLUMN full_name SET NOT NULL;

ALTER TABLE users DROP COLUMN first_name;
ALTER TABLE users DROP COLUMN last_name;
ALTER TABLE users DROP COLUMN display_name;

-- Phone is optional for legacy rows (NULL) but unique when present.
-- Postgres treats NULLs as distinct, so multiple NULL phone numbers are allowed.
ALTER TABLE users ADD CONSTRAINT uk_users_phone UNIQUE (phone_number);
