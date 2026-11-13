import express, { Router } from 'express';
import { currentUser, requireAuth, requireRole } from '../auth/auth.middleware';
import { created, ok } from '../common/api-response';
import { PRODUCT_STATUSES, type ProductStatus } from '../common/enums';
import { parsePageable } from '../common/pagination';
import { ValidationError, parseBody, pathUuid } from '../common/validation';
import type { Container } from '../container';
import { CATALOG_ROLES } from '../routes';
import { auditActor } from '../audit/audit.service';
import {
  parentSnapshots,
  productCreatedEvent,
  productDeletedEvent,
  productUpdatedEvents,
  statusEvent,
  stockEvent,
  variantSnapshot,
  variantUpdatedEvents,
} from '../audit/catalog-audit';
import {
  ADMIN_INVENTORY_SORTS,
  ADMIN_PRODUCT_SORTS,
  BulkDeleteSchema,
  BulkStatusSchema,
  IMAGE_ISSUE_SORTS,
  ParentUpdateSchema,
  ProductCreateSchema,
  STOCK_MOVEMENT_SORTS,
  StockAdjustmentSchema,
  VariantUpdateSchema,
} from './catalog.service';

/**
 * Catalog side of the admin API, mounted on /api/admin (FR-AD-01/03/05,
 * FR-IM-08/11). Every route admits ROLE_ADMIN and ROLE_CATALOG (FR-AD-08);
 * guards are per route, so other /api/admin paths fall through untouched.
 */
export function adminCatalogRoutes(c: Container): Router {
  const r = Router();
  const staff = [requireAuth, requireRole(...CATALOG_ROLES)];
  const svc = c.catalogAdmin;
  const actor = (req: express.Request) => {
    const u = currentUser(req);
    return { id: u.id, email: u.email };
  };
  const query = (req: express.Request, name: string) => {
    const v = req.query[name];
    return typeof v === 'string' && v.trim() !== '' ? v.trim() : undefined;
  };
  const uuidQuery = (req: express.Request, name: string) => {
    const v = query(req, name);
    return v === undefined ? undefined : pathUuid(v, name);
  };
  const productStatus = (req: express.Request) => {
    const v = query(req, 'status');
    if (v !== undefined && !(PRODUCT_STATUSES as readonly string[]).includes(v)) {
      throw new ValidationError({ status: `must be one of ${PRODUCT_STATUSES.join(', ')}` });
    }
    return v as ProductStatus | undefined;
  };

  r.get('/products', ...staff, async (req, res) => {
    const pageable = parsePageable(req, { sort: 'updatedAt,desc', allowedSorts: ADMIN_PRODUCT_SORTS });
    const filter = {
      search: query(req, 'search'),
      status: productStatus(req),
      categoryId: uuidQuery(req, 'categoryId'),
      subcategoryId: uuidQuery(req, 'subcategoryId'),
    };
    res.json(ok(await svc.listProducts(filter, pageable)));
  });
  r.post('/products', ...staff, async (req, res) => {
    const input = parseBody(ProductCreateSchema, req.body);
    const product = await svc.createProduct(input, actor(req));
    const [made] = (await parentSnapshots(c.prisma, [product.id])).values();
    if (made) {
      await c.audit.record(
        productCreatedEvent(auditActor(currentUser(req)), { ...made, variants: product.variants.map((v) => ({ sku: v.sku, status: v.status })) }),
      );
    }
    res.status(201).json(created(product, 'Product created'));
  });
  r.get('/products/status-counts', ...staff, async (req, res) => {
    const filter = {
      search: query(req, 'search'),
      categoryId: uuidQuery(req, 'categoryId'),
      subcategoryId: uuidQuery(req, 'subcategoryId'),
    };
    res.json(ok(await svc.productStatusCounts(filter)));
  });
  r.post('/products/status', ...staff, async (req, res) => {
    const input = parseBody(BulkStatusSchema, req.body);
    const before = await parentSnapshots(c.prisma, input.parentIds);
    const result = await svc.setStatus(input);
    const who = auditActor(currentUser(req));
    await c.audit.record(
      [...before.values()]
        .filter((p) => p.statuses.length && !(p.statuses.length === 1 && p.statuses[0] === input.status))
        .map((p) => ({ ...statusEvent(who, p, input.status!), details: { bulk: input.parentIds.length > 1 } })),
    );
    res.json(ok(result, `${result.products} product(s) set to ${result.status}`));
  });
  r.post('/products/delete', ...staff, async (req, res) => {
    const input = parseBody(BulkDeleteSchema, req.body);
    const before = await parentSnapshots(c.prisma, input.parentIds);
    const result = await svc.deleteProducts(input);
    const who = auditActor(currentUser(req));
    await c.audit.record([...before.values()].map((p) => ({ ...productDeletedEvent(who, p), details: { bulk: input.parentIds.length > 1 } })));
    res.json(ok(result, `${result.products} product(s) deleted`));
  });
  r.get('/products/:id', ...staff, async (req, res) => {
    res.json(ok(await svc.getProduct(pathUuid(req.params.id))));
  });
  r.patch('/products/:id', ...staff, async (req, res) => {
    const id = pathUuid(req.params.id);
    const input = parseBody(ParentUpdateSchema, req.body);
    const before = (await parentSnapshots(c.prisma, [id])).get(id);
    const product = await svc.updateProduct(id, input);
    const after = (await parentSnapshots(c.prisma, [id])).get(id);
    if (before && after) await c.audit.record(productUpdatedEvents(auditActor(currentUser(req)), before, after));
    res.json(ok(product, 'Product updated'));
  });

  r.patch('/variants/:id', ...staff, async (req, res) => {
    const id = pathUuid(req.params.id);
    const input = parseBody(VariantUpdateSchema, req.body);
    const before = await variantSnapshot(c.prisma, id);
    const variant = await svc.updateVariant(id, input, actor(req));
    const after = await variantSnapshot(c.prisma, id);
    if (before && after) await c.audit.record(variantUpdatedEvents(auditActor(currentUser(req)), before, after));
    res.json(ok(variant, 'Variant updated'));
  });
  r.post('/variants/:id/stock-adjustments', ...staff, async (req, res) => {
    const id = pathUuid(req.params.id);
    const input = parseBody(StockAdjustmentSchema, req.body);
    const row = await svc.adjustStock(id, input, actor(req));
    const v = await variantSnapshot(c.prisma, id);
    if (v) {
      await c.audit.record(
        // The level the adjustment wrote (a later checkout may already have moved it).
        stockEvent(auditActor(currentUser(req)), v, row.stockQuantity - input.delta, row.stockQuantity, 'Admin catalog', input.reason?.trim() || null, 'stock.adjusted'),
      );
    }
    res.json(ok(row, 'Stock adjusted'));
  });
  r.get('/variants/:id/stock-movements', ...staff, async (req, res) => {
    const pageable = parsePageable(req, { sort: 'createdAt,desc', allowedSorts: STOCK_MOVEMENT_SORTS });
    res.json(ok(await svc.stockMovements(pathUuid(req.params.id), pageable)));
  });

  r.get('/inventory', ...staff, async (req, res) => {
    const pageable = parsePageable(req, { sort: 'sku', allowedSorts: ADMIN_INVENTORY_SORTS });
    const stock = query(req, 'stock');
    if (stock !== undefined && stock !== 'low' && stock !== 'out') {
      throw new ValidationError({ stock: 'must be one of low, out' });
    }
    const filter = { search: query(req, 'search'), categoryId: uuidQuery(req, 'categoryId'), stock: stock as 'low' | 'out' | undefined };
    res.json(ok(await svc.listInventory(filter, pageable)));
  });
  r.get('/inventory/stats', ...staff, async (_req, res) => {
    res.json(ok(await svc.inventoryStats()));
  });

  r.get('/images/issues', ...staff, async (req, res) => {
    const pageable = parsePageable(req, { sort: 'checkedAt,desc', allowedSorts: IMAGE_ISSUE_SORTS });
    res.json(ok(await svc.imageIssues(pageable)));
  });
  r.post('/images/recheck', ...staff, async (req, res) => {
    const scope = query(req, 'scope') ?? 'problems';
    if (scope !== 'problems' && scope !== 'all') throw new ValidationError({ scope: 'must be one of problems, all' });
    const result = await svc.recheckImages(scope);
    res.json(ok(result, result.enabled ? `Checked ${result.checked} image(s), ${result.broken} broken` : 'Image checks are switched off'));
  });
  return r;
}
