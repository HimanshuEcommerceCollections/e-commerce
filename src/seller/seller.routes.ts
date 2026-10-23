import express, { Router } from 'express';
import multer from 'multer';
import { currentUser, requireAuth, requireRole } from '../auth/auth.middleware';
import { created, ok } from '../common/api-response';
import { SUBMISSION_KINDS, SUBMISSION_STATUSES, type SubmissionKind, type SubmissionStatus } from '../common/enums';
import { DomainError } from '../common/errors';
import { parsePageable } from '../common/pagination';
import { ValidationError, parseBody, pathUuid } from '../common/validation';
import type { Container } from '../container';
import { templateCsv } from '../product/importer/template';
import { CATALOG_ROLES } from '../routes';
import {
  RequiredNoteSchema,
  StockUpdateSchema,
  SUBMISSION_SORTS,
  SubmissionFormSchema,
  SubmissionNoteSchema,
  type Actor,
} from './submission.service';

const actor = (req: express.Request): Actor => {
  const u = currentUser(req);
  return { id: u.id, email: u.email };
};

const reference = (value: string | string[] | undefined) => {
  if (typeof value !== 'string' || !/^PS-\d{6}$/i.test(value)) throw new ValidationError({ reference: 'must be a submission reference (PS-123456)' });
  return value.toUpperCase();
};

const enumQuery = <T extends string>(req: express.Request, name: string, values: readonly T[]): T | undefined => {
  const v = req.query[name];
  if (v === undefined || v === '') return undefined;
  if (typeof v !== 'string' || !(values as readonly string[]).includes(v)) {
    throw new ValidationError({ [name]: `must be one of ${values.join(', ')}` });
  }
  return v as T;
};

/**
 * Seller portal, mounted on /api/seller (ROLE_MERCHANT). Sellers submit new
 * products and changes for review, take products off sale through review, and
 * set their own stock without review.
 */
export function sellerRoutes(c: Container): Router {
  const r = Router();
  const svc = c.submissions;
  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: c.config.catalogImport.maxFileSizeBytes, files: 1 },
  });
  const multipart: express.RequestHandler = (req, _res, next) => {
    if (!req.is('multipart/form-data')) {
      throw new DomainError(415, `Unsupported content type: ${req.headers['content-type'] ?? 'none'}`);
    }
    next();
  };
  r.use(requireAuth, requireRole('ROLE_MERCHANT'));

  r.get('/template', (_req, res) => {
    res.type('text/csv; charset=utf-8').attachment('catalog-import-template.csv').send(templateCsv());
  });

  r.get('/products', async (req, res) => {
    const pageable = parsePageable(req, { sort: 'updatedAt,desc', allowedSorts: ['updatedAt', 'createdAt', 'code', 'name'] });
    res.json(ok(await svc.myProducts(actor(req), pageable)));
  });
  /** A product saved as drafts goes to review. */
  r.post('/products/:id/submit', async (req, res) => {
    const { note } = parseBody(SubmissionNoteSchema, req.body ?? {});
    const data = await svc.submitDraft(pathUuid(req.params.id), actor(req), note);
    res.status(201).json(created(data, `Submitted for review as ${data.reference}`));
  });
  /** Taking a live product off sale needs approval too. */
  r.post('/products/:id/delist', async (req, res) => {
    const { note } = parseBody(RequiredNoteSchema, req.body);
    const data = await svc.requestDelist(pathUuid(req.params.id), actor(req), note);
    res.status(201).json(created(data, `Delisting requested as ${data.reference}`));
  });

  /** Bulk upload (multipart 'file', optional 'note') or form rows (JSON). */
  r.post('/submissions', async (req, res, next) => {
    if (req.is('multipart/form-data')) return next();
    const report = await svc.submitForm(parseBody(SubmissionFormSchema, req.body), actor(req));
    res.json(ok(report, `${report.submissions.length} submission(s) sent for review, ${report.failedRows} row(s) rejected`));
  });
  r.post('/submissions', multipart, upload.single('file'), async (req, res) => {
    if (!req.file) throw new DomainError(400, "Send the file as multipart/form-data in a part named 'file'");
    const { note } = parseBody(SubmissionNoteSchema, { note: req.body?.note || undefined });
    const report = await svc.submitFile(req.file, actor(req), note);
    res.json(ok(report, `${report.submissions.length} submission(s) sent for review, ${report.failedRows} row(s) rejected`));
  });
  r.get('/submissions', async (req, res) => {
    const pageable = parsePageable(req, { sort: 'submittedAt,desc', allowedSorts: SUBMISSION_SORTS });
    const status = enumQuery<SubmissionStatus>(req, 'status', SUBMISSION_STATUSES);
    res.json(ok(await svc.mySubmissions(actor(req), { status }, pageable)));
  });
  r.get('/submissions/:ref', async (req, res) => {
    res.json(ok(await svc.mySubmission(reference(req.params.ref), actor(req))));
  });
  r.post('/submissions/:ref/withdraw', async (req, res) => {
    res.json(ok(await svc.withdraw(reference(req.params.ref), actor(req)), 'Submission withdrawn'));
  });

  /** Stock applies at once, audited; no review. */
  r.post('/stock', async (req, res) => {
    const { items } = parseBody(StockUpdateSchema, req.body);
    const data = await svc.updateStock(actor(req), items);
    res.json(ok(data, `Stock updated for ${data.updated.length} SKU(s)`));
  });
  return r;
}

/**
 * The catalog team's side, mounted on /api/admin: the review queue and
 * decisions (any catalog staff, FR-AD-08), and seller stock alerts.
 */
export function adminSubmissionRoutes(c: Container): Router {
  const r = Router();
  const svc = c.submissions;
  const staff = [requireAuth, requireRole(...CATALOG_ROLES)];

  r.get('/submissions', ...staff, async (req, res) => {
    const pageable = parsePageable(req, { sort: 'submittedAt,asc', allowedSorts: SUBMISSION_SORTS });
    const filter = {
      status: enumQuery<SubmissionStatus>(req, 'status', SUBMISSION_STATUSES),
      kind: enumQuery<SubmissionKind>(req, 'kind', SUBMISSION_KINDS),
      merchantId: typeof req.query.merchantId === 'string' && req.query.merchantId ? pathUuid(req.query.merchantId, 'merchantId') : undefined,
    };
    res.json(ok(await svc.queue(filter, pageable)));
  });
  r.get('/submissions/counts', ...staff, async (_req, res) => {
    res.json(ok(await svc.counts()));
  });
  r.get('/submissions/:ref', ...staff, async (req, res) => {
    res.json(ok(await svc.get(reference(req.params.ref))));
  });
  r.post('/submissions/:ref/claim', ...staff, async (req, res) => {
    res.json(ok(await svc.claim(reference(req.params.ref), actor(req)), 'Submission in review'));
  });
  r.post('/submissions/:ref/approve', ...staff, async (req, res) => {
    const { note } = parseBody(SubmissionNoteSchema, req.body ?? {});
    res.json(ok(await svc.approve(reference(req.params.ref), actor(req), note), 'Submission approved'));
  });
  r.post('/submissions/:ref/request-changes', ...staff, async (req, res) => {
    const { note } = parseBody(RequiredNoteSchema, req.body);
    res.json(ok(await svc.requestChanges(reference(req.params.ref), actor(req), note), 'Changes requested'));
  });
  r.post('/submissions/:ref/reject', ...staff, async (req, res) => {
    const { note } = parseBody(RequiredNoteSchema, req.body);
    res.json(ok(await svc.reject(reference(req.params.ref), actor(req), note), 'Submission rejected'));
  });

  r.get('/seller-stock-alerts', ...staff, async (req, res) => {
    const raw = typeof req.query.days === 'string' ? Number(req.query.days) : 7;
    if (!Number.isInteger(raw) || raw < 1 || raw > 90) throw new ValidationError({ days: 'must be an integer from 1 to 90' });
    res.json(ok(await svc.stockAlerts(raw)));
  });
  return r;
}
