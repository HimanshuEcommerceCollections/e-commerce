import express, { Router } from 'express';
import multer from 'multer';
import { currentUser, requireAuth, requireRole } from '../auth/auth.middleware';
import { ok } from '../common/api-response';
import { DomainError } from '../common/errors';
import { ValidationError } from '../common/validation';
import type { Container } from '../container';
import { CATALOG_ROLES } from '../routes';
import { templateCsv } from './importer/template';

/**
 * Catalog files (FR-IM-01..12, NFR-06): import (merchants import their own
 * products; catalog staff manage every product), the template, bulk price and
 * stock updates, and the export.
 */
export function catalogRoutes(c: Container): Router {
  const r = Router();
  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: c.config.catalogImport.maxFileSizeBytes, files: 1 },
  });
  const isStaff = (role: string) => (CATALOG_ROLES as readonly string[]).includes(role);
  const multipart: express.RequestHandler = (req, _res, next) => {
    if (!req.is('multipart/form-data')) {
      throw new DomainError(415, `Unsupported content type: ${req.headers['content-type'] ?? 'none'}`);
    }
    next();
  };
  const fileOf = (req: express.Request) => {
    if (!req.file) throw new DomainError(400, "Send the file as multipart/form-data in a part named 'file'");
    return req.file;
  };
  const anyCatalogUser = [requireAuth, requireRole('ROLE_MERCHANT', ...CATALOG_ROLES)];
  const staffOnly = [requireAuth, requireRole(...CATALOG_ROLES)];

  r.post('/import', ...anyCatalogUser, multipart, upload.single('file'), async (req, res) => {
    const file = fileOf(req);
    const user = currentUser(req);
    const report = await c.catalogImport.importFile(file, user.id, { staff: isStaff(user.role), actor: user.email });
    res.json(ok(report, `Imported ${report.importedRows} of ${report.totalRows} rows`));
  });

  r.get('/import/template', ...anyCatalogUser, (_req, res) => {
    res.type('text/csv; charset=utf-8').attachment('catalog-import-template.csv').send(templateCsv());
  });

  r.post('/updates', ...staffOnly, multipart, upload.single('file'), async (req, res) => {
    const report = await c.catalogUpdates.updateFile(fileOf(req), currentUser(req).email);
    res.json(ok(report, `Updated ${report.updatedRows} of ${report.totalRows} rows`));
  });

  r.get('/export', ...staffOnly, async (req, res) => {
    const format = typeof req.query.format === 'string' ? req.query.format.toLowerCase() : 'csv';
    if (format !== 'csv' && format !== 'xlsx') throw new ValidationError({ format: 'must be one of csv, xlsx' });
    const file = await c.catalogExport.export(format);
    res.type(file.contentType).attachment(file.fileName).set('X-Total-Rows', String(file.rows)).send(file.body);
  });
  return r;
}
