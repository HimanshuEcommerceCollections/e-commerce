import express, { Router } from 'express';
import multer from 'multer';
import { currentUser } from '../auth/auth.middleware';
import { ok } from '../common/api-response';
import { DomainError } from '../common/errors';
import { parsePageable } from '../common/pagination';
import { ValidationError, parseBody, pathUuid } from '../common/validation';
import type { Container } from '../container';
import { CatalogFileReader } from '../product/importer/file-reader';
import { ORDER_FILTERS, PriceChangeSchema, SellerPortalService, type OrderFilter } from './seller-portal.service';
import type { Actor } from './submission.service';

const actor = (req: express.Request): Actor => {
  const u = currentUser(req);
  return { id: u.id, email: u.email };
};

const intQuery = (req: express.Request, name: string, fallback: number, min: number, max: number) => {
  const raw = req.query[name];
  if (raw === undefined || raw === '') return fallback;
  const n = typeof raw === 'string' ? Number(raw) : NaN;
  if (!Number.isInteger(n) || n < min || n > max) throw new ValidationError({ [name]: `must be an integer from ${min} to ${max}` });
  return n;
};

/**
 * The seller portal's screens beyond submitting: catalog overview, upload
 * check, price requests, review activity, stock history, orders and earnings.
 * Mounted inside sellerRoutes, behind its ROLE_MERCHANT check.
 */
export function sellerPortalRoutes(c: Container): Router {
  const r = Router();
  const svc = new SellerPortalService(
    c.prisma,
    new CatalogFileReader(c.config.catalogImport.maxRows),
    c.catalogImport,
    c.catalogExport,
    c.submissions,
    c.config,
  );
  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: c.config.catalogImport.maxFileSizeBytes, files: 1 },
  });

  r.get('/catalog', async (req, res) => {
    res.json(ok(await svc.catalog(actor(req))));
  });
  r.get('/products/:id/rows', async (req, res) => {
    res.json(ok(await svc.rows(pathUuid(req.params.id), actor(req))));
  });
  r.get('/products/:id/stock-history', async (req, res) => {
    res.json(ok(await svc.stockHistory(pathUuid(req.params.id), actor(req))));
  });
  /** A price change is an edit: reviewed before shoppers see it. */
  r.post('/products/:id/price', async (req, res) => {
    const report = await svc.requestPriceChange(pathUuid(req.params.id), actor(req), parseBody(PriceChangeSchema, req.body));
    res.json(ok(report, report.submissions.length ? `Price change sent for review as ${report.submissions[0].reference}` : 'Nothing to change'));
  });

  /** Checks an upload without sending anything (multipart 'file'). */
  r.post('/submissions/check', upload.single('file'), async (req, res) => {
    if (!req.file) throw new DomainError(400, "Send the file as multipart/form-data in a part named 'file'");
    const report = await svc.check(req.file, actor(req));
    res.json(ok(report, `${report.totalRows} row(s) checked, ${report.toFix} to fix`));
  });
  r.get('/price-changes', async (req, res) => {
    res.json(ok(await svc.priceChanges(actor(req))));
  });
  r.get('/activity', async (req, res) => {
    res.json(ok(await svc.activity(actor(req), intQuery(req, 'limit', 20, 1, 100))));
  });

  r.get('/orders', async (req, res) => {
    const raw = req.query.status;
    if (raw !== undefined && raw !== '' && !(typeof raw === 'string' && (ORDER_FILTERS as readonly string[]).includes(raw))) {
      throw new ValidationError({ status: `must be one of ${ORDER_FILTERS.join(', ')}` });
    }
    const pageable = parsePageable(req, { sort: 'paidAt,desc', allowedSorts: ['paidAt'] });
    res.json(ok(await svc.orders(actor(req), (raw || undefined) as OrderFilter | undefined, pageable)));
  });
  r.get('/earnings', async (req, res) => {
    res.json(ok(await svc.earnings(actor(req), intQuery(req, 'months', 6, 1, 24))));
  });
  return r;
}
