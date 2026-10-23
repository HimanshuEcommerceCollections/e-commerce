# NexusCommerce API (TypeScript)

TypeScript port of `ecom-server` (Spring Boot): **Express 5 + zod + Prisma 6 + PostgreSQL 16**, Node 22.

The HTTP API and the database schema are the Java server's, unchanged. The web client, the Postman collection and existing databases keep working, and both servers can run against one database while you switch over. Tokens issued by one server are accepted by the other if both use the same `JWT_SECRET`.

## Run it

```bash
cp .env.example .env            # set JWT_SECRET (32+ bytes) and the DB_* values
docker compose up --build       # Postgres 16 + API on http://localhost:8080
```

Without Docker:

```bash
npm ci
npm run build
npm run migrate                 # apply prisma/migrations (see "Database" below)
npm start
# or, for development with reload:  npx tsx src/scripts/migrate.ts && npm run dev
npm run seed:accounts           # staff and test logins from SEED_* in .env
npm run seed:demo               # optional: demo accounts, the design's sample catalog and orders
npm run demo:csv -- --image-base https://<web-client>/daylora   # the demo catalog as an import file
```

`seed:accounts` upserts the logins set by `SEED_ADMIN_EMAIL` / `SEED_ADMIN_PASSWORD`, `SEED_CATALOG_*` and `SEED_CUSTOMER_*` (see `.env.example`), skipping any without both; the Docker image runs it on every start, so the deployment's environment is the source of truth for those passwords.

`demo:csv` writes `demo-catalog.csv` in the import template (one row per SKU, the same codes and slugs as `seed:demo`), for loading a deployed store through `POST /api/catalog/import` or the admin panel. Image URLs must be absolute and reachable, so pass the deployed web client's `/daylora` folder. Category codes come from `DATABASE_URL`, so point it at the target database (or one migrated the same way).

`seed:demo` is idempotent. Accounts come from the `SEED_*` variables when set, otherwise: `admin@example.com` / `Admin12345` (admin), `catalog@example.com` / `Catalog12345` (catalog staff), `jordan.m@example.com` / `Customer123` (customer with orders in several states). Product images point at the web client's `public/daylora/` files on `http://localhost:3000`. In Docker, set `SEED_DEMO=true` to run it on container start (each run resets the demo SKUs' prices and stock), and `DEMO_IMAGE_BASE` (e.g. `https://<web-client>/daylora`) to point the images at a deployed web client.

On Vercel (project `e-commerce-server`): `api/index.ts` exports the Express app and `vercel.json` rewrites every path to it. Set `DATABASE_URL`, `JWT_SECRET`, `CORS_ALLOWED_ORIGINS` and `CRON_SECRET` in the project's Environment Variables, with `SERVER_FORWARD_HEADERS_STRATEGY=framework` (Vercel is a reverse proxy). There is no long-lived process, so the pending-order expiry scan runs from the Vercel cron in `vercel.json`, which calls `/internal/cron/expire-pending` with `Authorization: Bearer $CRON_SECRET`. Vercel caps request bodies at 4.5 MB, so keep `CATALOG_IMPORT_MAX_FILE_SIZE` at or below that there.

Checks:

```bash
npm run typecheck
npm test                        # starts an embedded Postgres 16; no Docker, never your .env database
TEST_DATABASE_URL=postgresql://... npm test   # or point the tests at an empty database of your own
```

## Layout

| Path | What |
|---|---|
| `src/server.ts` | Entrypoint: config, Prisma, HTTP server, pending-order expiry job |
| `src/app.ts`, `src/routes.ts` | Express app, middleware order, routes |
| `src/container.ts` | Service wiring (tests pass a scripted payment gateway) |
| `src/config.ts` | Environment variables (same names as the Java server) |
| `src/common/` | ApiResponse envelope, errors, zod field validators, Spring-style pagination, error handler |
| `src/auth/` | JWT, bcrypt login/register, bearer auth and role guards, auth rate limiter |
| `src/user/` | Addresses |
| `src/product/` | Categories, products (parent product + variant SKUs), `importer/` (catalog bulk import) |
| `src/cart/`, `src/order/` | Cart, checkout, cancellation, payment-event handling, pending-order expiry |
| `src/payment/` | Gateway interface, manual and Stripe gateways, webhook store and service |
| `src/seller/` | Seller portal: submissions, the review queue and seller stock |
| `prisma/` | Schema and migrations |
| `test/` | Vitest integration tests against a real Postgres |
| `postman/` | Postman collection, environment and a sample import file |

## Database

`prisma/schema.prisma` maps the Java server's Flyway V1–V10 schema column for column. `prisma migrate diff` reports no differences apart from the additive `1_column_defaults` migration, and CI checks this.

- `0_init` is Flyway V1–V10, verbatim. Some things exist only in that SQL, because Prisma can't express them: five partial unique indexes and the `chk_products_stock_non_negative` CHECK. The race-safety of carts, addresses, primary images and checkout idempotency depends on them. **When you generate a new migration, check it doesn't drop them.**
- `1_column_defaults` adds DB defaults for Prisma's `@default` fields. It is harmless to the Java server.
- `2_storefront_operations` adds the taxonomy (department → section, seeded with the 9 frozen departments and 18 sections), catalog template fields, guest orders (`orders.user_id` nullable), fulfilment, shipments, returns, stock movements, analytics events, notifications, password reset, seller applications and support messages. Two more partial unique indexes live only in its SQL: `uniq_orders_guest_idempotency_key` and `uniq_products_url_slug`.
- `3_seller_portal` adds `product_submissions` and their event history. One partial unique index lives only in its SQL: `uniq_product_submissions_open_parent` (one open submission per product).
- `npm run migrate` (`src/scripts/migrate.ts`) runs on every container start:
  - **Fresh database:** applies every migration.
  - **Database built by the Java server with Flyway at V10:** marks `0_init` as already applied, then applies the rest. Tested against a live Flyway-migrated database.
  - **Flyway below V10:** stops with an error. Bring the database to V10 with the Java server first.
- Stock and order state changes are guarded SQL `UPDATE`s in `src/order/order.repository.ts`, as in the Java server (NFR-08). Don't rewrite them as read-then-write.

## Seller portal

Sellers (`ROLE_MERCHANT`) change the catalog only through review. Their direct writes (`POST/PUT/DELETE /api/products`, `POST /api/catalog/import`) now answer 403.

| Seller (`/api/seller`) | |
|---|---|
| `POST /submissions` | Bulk upload (multipart `file`, optional `note`) or form rows (JSON `{rows, note}`), in the import template's columns |
| `GET /submissions`, `GET /submissions/:ref`, `POST /submissions/:ref/withdraw` | The seller's submissions, with the reviewer's notes |
| `GET /products` | The seller's products and their state: `DRAFT`, `SUBMITTED`, `IN_REVIEW`, `CHANGES_REQUESTED`, `LIVE`, `CHANGE_PENDING`, `SUSPENDED`, `ARCHIVED` |
| `POST /products/:id/submit`, `POST /products/:id/delist` | Send a saved draft for review; ask to take a live product off sale |
| `POST /stock` | `{items: [{sku, quantity}]}`, applied at once without review |
| `GET /template` | The import template |

| Catalog team (`/api/admin`, admins and `ROLE_CATALOG`) | |
|---|---|
| `GET /submissions`, `GET /submissions/counts` | The queue: open submissions, oldest first; filter by `status`, `kind`, `merchantId` |
| `GET /submissions/:ref` | Before and after per SKU, and the history |
| `POST /submissions/:ref/claim`, `/approve`, `/request-changes`, `/reject` | Decisions. Request changes and reject need a `note` |
| `GET /seller-stock-alerts?days=7` | Seller stock that dropped to zero |

How it works:

- **Automated checks** run first: the importer's validation as a dry run (fields, categories, duplicate SKUs, ownership) and image URL checks. Failing rows are rejected with per-row errors; the rest carry on.
- **A product not yet live** is written as `DRAFT` SKUs, so its codes are reserved and customers can't see it. A `NEW_PRODUCT` submission asks for each SKU's `Product_Status` on approval. A row with `Product_Status` `DRAFT` is saved without being submitted.
- **A change to a live product** never touches it. The rows wait in an `EDIT` submission, and the reviewer sees a field-by-field diff against the live row. Approval imports them as the seller, leaving stock alone.
- **Stock applies at once**, under row locks, as a `SELLER` stock movement. A drop to zero is logged and listed in the stock alerts.
- **Uploading again** while a submission waits, or after changes were requested, updates that submission. While a reviewer has it, the upload is rejected.
- Every decision is mailed to the seller (log-only mailer).

## Differences from the Java server

Verified by running both servers against one database and diffing responses for the same requests, covering reads, errors, the cart → checkout → cancel flow and catalog import. Everything matched except:

- **Fixed 500s.** These requests returned 500 from the Java server and now return proper errors:
  - malformed JSON body → 400
  - non-UUID path id → 400
  - unknown sort field → 400
  - unknown route → 404
  - wrong-type body field → 400 with a field message
- **Legacy `.xls` isn't accepted** by catalog import. `.csv` and `.xlsx` are.
- **Timestamps have millisecond precision** (Java printed microseconds).
- **Order state claims also set `updated_at`** (the Java bulk updates left it unchanged).

## Security notes

`npm audit --omit=dev` reports two advisories, neither reachable from request data:

- `deepmerge-ts`, used inside the Prisma CLI's config loader
- `uuid` inside `exceljs`: only its buffer-argument v3/v5/v6 functions are affected, and they aren't used on uploads

Re-check when upgrading Prisma or ExcelJS.
