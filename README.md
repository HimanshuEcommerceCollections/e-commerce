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
npm run seed:demo               # optional: demo accounts, the design's sample catalog and orders
```

`seed:demo` is idempotent. Accounts: `admin@example.com` / `Admin12345` (admin), `catalog@example.com` / `Catalog12345` (catalog staff), `jordan.m@example.com` / `Customer123` (customer with orders in several states). Product images point at the web client's `public/daylora/` files on `http://localhost:3000`.

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
| `prisma/` | Schema and migrations |
| `test/` | Vitest integration tests against a real Postgres |
| `postman/` | Postman collection, environment and a sample import file |

## Database

`prisma/schema.prisma` maps the Java server's Flyway V1–V10 schema column for column. `prisma migrate diff` reports no differences apart from the additive `1_column_defaults` migration, and CI checks this.

- `0_init` is Flyway V1–V10, verbatim. Some things exist only in that SQL, because Prisma can't express them: five partial unique indexes and the `chk_products_stock_non_negative` CHECK. The race-safety of carts, addresses, primary images and checkout idempotency depends on them. **When you generate a new migration, check it doesn't drop them.**
- `1_column_defaults` adds DB defaults for Prisma's `@default` fields. It is harmless to the Java server.
- `2_storefront_operations` adds the taxonomy (department → section, seeded with the 9 frozen departments and 18 sections), catalog template fields, guest orders (`orders.user_id` nullable), fulfilment, shipments, returns, stock movements, analytics events, notifications, password reset, seller applications and support messages. Two more partial unique indexes live only in its SQL: `uniq_orders_guest_idempotency_key` and `uniq_products_url_slug`.
- `npm run migrate` (`src/scripts/migrate.ts`) runs on every container start:
  - **Fresh database:** applies every migration.
  - **Database built by the Java server with Flyway at V10:** marks `0_init` as already applied, then applies the rest. Tested against a live Flyway-migrated database.
  - **Flyway below V10:** stops with an error. Bring the database to V10 with the Java server first.
- Stock and order state changes are guarded SQL `UPDATE`s in `src/order/order.repository.ts`, as in the Java server (NFR-08). Don't rewrite them as read-then-write.

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
