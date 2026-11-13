import express, { Router } from 'express';
import multer from 'multer';
import { currentUser, requireAuth, requireRole } from '../auth/auth.middleware';
import { ok } from '../common/api-response';
import { DomainError, SellerReviewRequiredError } from '../common/errors';
import { ValidationError } from '../common/validation';
import type { Container } from '../container';
import { CATALOG_ROLES } from '../routes';
import { templateCsv } from './importer/template';
import { auditActor } from '../audit/audit.service';

/**
 * Catalog files (FR-IM-01..12, NFR-06): import (catalog staff; sellers submit
 * through /api/seller/submissions for review), the template, bulk price and
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
  const sellersSubmitForReview: express.RequestHandler = (req, _res, next) => {
    if (currentUser(req).role === 'ROLE_MERCHANT') throw new SellerReviewRequiredError();
    next();
  };
  const staffOnly = [requireAuth, requireRole(...CATALOG_ROLES)];

  r.post('/import', requireAuth, sellersSubmitForReview, requireRole(...CATALOG_ROLES), multipart, upload.single('file'), async (req, res) => {
    const file = fileOf(req);
    const user = currentUser(req);
    const report = await c.catalogImport.importFile(file, user.id, { staff: isStaff(user.role), actor: user.email });
    await c.audit.record({
      action: 'catalog.imported',
      category: 'import',
      actor: auditActor(user),
      source: 'Catalog import',
      entity: { type: 'import', code: report.fileName, label: `Import ${report.fileName}` },
      summary: `Imported ${report.importedRows} of ${report.totalRows} rows: ${report.createdRows} created, ${report.updatedRows} updated, ${report.failedRows} failed`,
      before: '—',
      after: `${report.parentProductsCreated} product(s) created, ${report.parentProductsUpdated} updated`,
      details: {
        totalRows: report.totalRows,
        importedRows: report.importedRows,
        failedRows: report.failedRows,
        skus: report.imported.slice(0, 500).map((i) => i.sku),
        errors: report.errors.slice(0, 50),
      },
    });
    res.json(ok(report, `Imported ${report.importedRows} of ${report.totalRows} rows`));
  });

  r.get('/import/template', ...anyCatalogUser, (_req, res) => {
    res.type('text/csv; charset=utf-8').attachment('catalog-import-template.csv').send(templateCsv());
  });

  r.post('/updates', ...staffOnly, multipart, upload.single('file'), async (req, res) => {
    const report = await c.catalogUpdates.updateFile(fileOf(req), currentUser(req).email);
    await c.audit.record({
      action: 'catalog.bulk_updated',
      category: 'import',
      actor: auditActor(currentUser(req)),
      source: 'Bulk update',
      entity: { type: 'import', code: report.fileName, label: `Bulk update ${report.fileName}` },
      summary: `Bulk ${report.columns.join(', ') || 'update'}: ${report.updatedRows} of ${report.totalRows} rows updated, ${report.failedRows} failed`,
      before: '—',
      after: `${report.updatedRows} SKU(s) updated`,
      details: { columns: report.columns, totalRows: report.totalRows, updatedRows: report.updatedRows, errors: report.errors.slice(0, 50) },
    });
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
