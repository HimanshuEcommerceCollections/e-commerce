import express, { Router } from 'express';
import multer from 'multer';
import { currentUser, requireAuth, requireRole } from '../auth/auth.middleware';
import { created, ok } from '../common/api-response';
import { DomainError } from '../common/errors';
import { ValidationError, parseBody, pathUuid } from '../common/validation';
import type { Container } from '../container';
import type { DownloadFile } from './onboarding.service';
import {
  ApproveSchema,
  DeclineSchema,
  DocumentRejectSchema,
  DocumentReviewSchema,
  MAX_DOCUMENT_BYTES,
  RemindSchema,
  SUPPLIER_STAGES,
  SUPPLIER_VIEWS,
  SaveDraftSchema,
  ScoreOverrideSchema,
  ScorecardSchema,
  SubmitApplicationSchema,
  SuspendSchema,
  type SupplierStage,
  type SupplierView,
} from './onboarding.rules';

/** Document uploads, kept in memory and stored in the database (no local disk on serverless hosts). */
function documentUpload() {
  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_DOCUMENT_BYTES, files: 1 } });
  const multipart: express.RequestHandler = (req, _res, next) => {
    if (!req.is('multipart/form-data')) {
      throw new DomainError(415, `Unsupported content type: ${req.headers['content-type'] ?? 'none'}`);
    }
    next();
  };
  return [multipart, upload.single('file')] as const;
}

function sendFile(res: express.Response, file: DownloadFile) {
  res.setHeader('Content-Type', file.contentType);
  res.attachment(file.fileName);
  res.setHeader('Cache-Control', 'private, no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.send(file.content);
}

/**
 * Seller documents, mounted on /api/seller (ROLE_MERCHANT) before the seller
 * portal router. Guards are per route so other /api/seller paths fall through.
 */
export function sellerDocumentRoutes(c: Container): Router {
  const r = Router();
  const seller = [requireAuth, requireRole('ROLE_MERCHANT')];
  const svc = c.supplierOnboarding;

  r.get('/documents', ...seller, async (req, res) => {
    res.json(ok(await svc.listDocuments(currentUser(req).id)));
  });
  r.post('/documents', ...seller, ...documentUpload(), async (req, res) => {
    const doc = await svc.uploadDocument(currentUser(req), req.body?.type, req.file, req.body?.expiresAt);
    res.status(201).json(created(doc, 'Document uploaded'));
  });
  r.get('/documents/:id/file', ...seller, async (req, res) => {
    sendFile(res, await svc.ownDocumentFile(currentUser(req).id, pathUuid(req.params.id)));
  });
  r.get('/agreement', ...seller, (_req, res) => {
    sendFile(res, svc.agreement());
  });
  return r;
}

/**
 * The applicant's side, mounted on /api/seller-onboarding (any signed-in
 * account): the application draft, submit, and the documents step.
 */
export function sellerOnboardingRoutes(c: Container): Router {
  const r = Router();
  const svc = c.supplierOnboarding;
  r.use(requireAuth);

  r.get('/application', async (req, res) => {
    res.json(ok(await svc.getMine(currentUser(req))));
  });
  r.put('/application', async (req, res) => {
    const input = parseBody(SaveDraftSchema, req.body);
    res.json(ok(await svc.saveDraft(currentUser(req), input), 'Saved'));
  });
  r.post('/application/submit', async (req, res) => {
    parseBody(SubmitApplicationSchema, req.body);
    res.json(ok(await svc.submit(currentUser(req)), 'Application submitted'));
  });

  r.get('/documents', async (req, res) => {
    res.json(ok(await svc.listDocuments(currentUser(req).id)));
  });
  r.post('/documents', ...documentUpload(), async (req, res) => {
    const user = currentUser(req);
    await svc.assertCanUploadAsApplicant(user);
    const doc = await svc.uploadDocument(user, req.body?.type, req.file, req.body?.expiresAt);
    res.status(201).json(created(doc, 'Document uploaded'));
  });
  r.get('/documents/:id/file', async (req, res) => {
    sendFile(res, await svc.ownDocumentFile(currentUser(req).id, pathUuid(req.params.id)));
  });
  r.get('/agreement', (_req, res) => {
    sendFile(res, svc.agreement());
  });
  return r;
}

/** Supplier approvals, mounted on /api/admin (ROLE_ADMIN, like the seller-applications inbox). */
export function adminSupplierRoutes(c: Container): Router {
  const r = Router();
  const admin = [requireAuth, requireRole('ROLE_ADMIN')];
  const svc = c.supplierOnboarding;
  const by = (req: express.Request) => currentUser(req).email;
  const base = '/supplier-applications';
  const enumQuery = <T extends string>(req: express.Request, name: string, values: readonly T[]): T | undefined => {
    const v = req.query[name];
    if (v === undefined || v === '') return undefined;
    if (typeof v !== 'string' || !(values as readonly string[]).includes(v)) {
      throw new ValidationError({ [name]: `must be one of ${values.join(', ')}` });
    }
    return v as T;
  };

  r.get(base, ...admin, async (req, res) => {
    const q = typeof req.query.q === 'string' ? req.query.q : undefined;
    res.json(
      ok(
        await svc.list({
          view: enumQuery<SupplierView>(req, 'view', SUPPLIER_VIEWS),
          stage: enumQuery<SupplierStage>(req, 'stage', SUPPLIER_STAGES),
          q,
        }),
      ),
    );
  });
  r.get(`${base}/:id`, ...admin, async (req, res) => {
    res.json(ok(await svc.get(pathUuid(req.params.id))));
  });
  r.put(`${base}/:id/scorecard`, ...admin, async (req, res) => {
    const id = pathUuid(req.params.id);
    res.json(ok(await svc.saveScorecard(id, parseBody(ScorecardSchema, req.body), by(req)), 'Scorecard saved'));
  });
  r.put(`${base}/:id/score-override`, ...admin, async (req, res) => {
    const id = pathUuid(req.params.id);
    res.json(ok(await svc.overrideScore(id, parseBody(ScoreOverrideSchema, req.body), by(req)), 'Score updated'));
  });
  r.post(`${base}/:id/pass`, ...admin, async (req, res) => {
    res.json(ok(await svc.pass(pathUuid(req.params.id), by(req)), 'Passed. Documents requested'));
  });
  r.post(`${base}/:id/decline`, ...admin, async (req, res) => {
    const id = pathUuid(req.params.id);
    res.json(ok(await svc.decline(id, parseBody(DeclineSchema, req.body), by(req)), 'Declined'));
  });
  r.post(`${base}/:id/reopen`, ...admin, async (req, res) => {
    res.json(ok(await svc.reopen(pathUuid(req.params.id), by(req)), 'Reopened for scoring'));
  });
  r.post(`${base}/:id/override-screening`, ...admin, async (req, res) => {
    res.json(ok(await svc.overrideScreening(pathUuid(req.params.id), by(req)), 'Override recorded'));
  });
  r.post(`${base}/:id/remind`, ...admin, async (req, res) => {
    const id = pathUuid(req.params.id);
    res.json(ok(await svc.remind(id, parseBody(RemindSchema, req.body), by(req)), 'Reminder sent'));
  });
  r.post(`${base}/:id/approve`, ...admin, async (req, res) => {
    const id = pathUuid(req.params.id);
    res.json(ok(await svc.approve(id, parseBody(ApproveSchema, req.body), by(req)), 'Supplier approved'));
  });
  r.post(`${base}/:id/suspend`, ...admin, async (req, res) => {
    const id = pathUuid(req.params.id);
    res.json(ok(await svc.suspend(id, parseBody(SuspendSchema, req.body), by(req)), 'Supplier suspended'));
  });
  r.post(`${base}/:id/reinstate`, ...admin, async (req, res) => {
    res.json(ok(await svc.reinstate(pathUuid(req.params.id), by(req)), 'Supplier reinstated'));
  });
  r.get(`${base}/:id/documents/:docId/file`, ...admin, async (req, res) => {
    sendFile(res, await svc.adminDocumentFile(pathUuid(req.params.id), pathUuid(req.params.docId)));
  });
  r.post(`${base}/:id/documents/:docId/verify`, ...admin, async (req, res) => {
    const [id, docId] = [pathUuid(req.params.id), pathUuid(req.params.docId)];
    res.json(ok(await svc.verifyDocument(id, docId, parseBody(DocumentReviewSchema, req.body), by(req)), 'Document verified'));
  });
  r.post(`${base}/:id/documents/:docId/reject`, ...admin, async (req, res) => {
    const [id, docId] = [pathUuid(req.params.id), pathUuid(req.params.docId)];
    res.json(ok(await svc.rejectDocument(id, docId, parseBody(DocumentRejectSchema, req.body), by(req)), 'Asked the supplier to upload it again'));
  });
  return r;
}
