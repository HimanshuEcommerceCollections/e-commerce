import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { harness } from './support/harness';

/**
 * Supplier onboarding: the applicant's draft and submit, automatic screening,
 * the scorecard, documents, approval granting ROLE_MERCHANT, suspension
 * blocking /api/seller, and the seller documents API with ownership checks.
 */
const { app, prisma, fixtures } = harness();

let admin: string;
let merchant: string;
let otherMerchant: string;

const auth = (token: string) => ({
  get: (url: string) => request(app).get(url).set('Authorization', `Bearer ${token}`),
  put: (url: string, body: object = {}) => request(app).put(url).set('Authorization', `Bearer ${token}`).send(body),
  post: (url: string, body: object = {}) => request(app).post(url).set('Authorization', `Bearer ${token}`).send(body),
  upload: (url: string, type: string, name: string, content: string, expiresAt?: string) => {
    const req = request(app).post(url).set('Authorization', `Bearer ${token}`).field('type', type);
    if (expiresAt) req.field('expiresAt', expiresAt);
    return req.attach('file', Buffer.from(content), name);
  },
});

const future = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);

const FORM = {
  legalName: 'BrightNest Kitchen LLC',
  ein: '12-3456789',
  website: 'https://brightnest.example',
  businessType: 'Brand owner',
  yearsInBusiness: '3–5',
  phone: '(555) 201-7788',
  street: '120 Market St',
  city: 'Columbus',
  state: 'OH',
  zip: '43215',
  categories: ['Kitchen & dining'],
  productCount: '50–200',
  ownBrand: 'yes',
  brands: 'BrightNest',
  usWarehouse: 'yes',
  warehouseState: 'OH',
  shipsAllStates: 'yes',
  handlingTime: '1 business day',
  carriers: ['UPS', 'USPS'],
  productData: 'csv',
  moq: '1',
};

const userOf = async (token: string) => {
  const me = await request(app).get('/api/users/me').set('Authorization', `Bearer ${token}`);
  return prisma.user.findUniqueOrThrow({ where: { email: me.body.data.email } });
};

/** A signed-in applicant with a submitted application; returns the token and application id. */
async function submitted(form: object = FORM) {
  const token = await fixtures.registerUser('ROLE_CUSTOMER');
  const a = auth(token);
  expect((await a.put('/api/seller-onboarding/application', { step: 1, companyName: 'BrightNest', form })).status).toBe(200);
  const res = await a.post('/api/seller-onboarding/application/submit', { confirm: true });
  expect(res.status).toBe(200);
  return { token, id: res.body.data.id as string, view: res.body.data };
}

const ALL_FIVES = { fit: 5, data: 4, price: 4, ship: 4, quality: 4, stable: 4 };

/** Submitted, scored and passed: the applicant can upload documents. */
async function atDocuments() {
  const s = await submitted();
  expect((await auth(admin).put(`/api/admin/supplier-applications/${s.id}/scorecard`, { scores: ALL_FIVES })).status).toBe(200);
  expect((await auth(admin).post(`/api/admin/supplier-applications/${s.id}/pass`)).status).toBe(200);
  return s;
}

async function uploadAll(token: string, base = '/api/seller-onboarding') {
  const a = auth(token);
  const ids: Record<string, string> = {};
  for (const [type, name] of [['W9', 'w9.pdf'], ['AGREEMENT', 'agreement.pdf'], ['INSURANCE', 'coi.png']]) {
    const res = await a.upload(`${base}/documents`, type, name, `%PDF ${type}`, type === 'INSURANCE' ? future(300) : undefined);
    expect(res.status).toBe(201);
    ids[type] = res.body.data.id;
  }
  return ids;
}

beforeAll(async () => {
  admin = await fixtures.registerUser('ROLE_ADMIN');
  merchant = await fixtures.registerUser('ROLE_MERCHANT');
  otherMerchant = await fixtures.registerUser('ROLE_MERCHANT');
});

describe('applicant draft and submit', () => {
  it('saves a draft server-side, resumes it and keeps it out of the admin queues', async () => {
    const token = await fixtures.registerUser('ROLE_CUSTOMER');
    const a = auth(token);
    expect((await a.get('/api/seller-onboarding/application')).body.data).toBeUndefined();

    const saved = await a.put('/api/seller-onboarding/application', { step: 0, companyName: 'Half Done Co', form: { legalName: 'Half Done Co' } });
    expect(saved.status).toBe(200);
    expect(saved.body.data).toMatchObject({ stage: 'DRAFT', step: 0, form: { legalName: 'Half Done Co' } });

    await a.put('/api/seller-onboarding/application', { step: 2, form: { ein: '12-3456789' } });
    const resumed = (await a.get('/api/seller-onboarding/application')).body.data;
    expect(resumed).toMatchObject({ stage: 'DRAFT', step: 2, form: { legalName: 'Half Done Co', ein: '12-3456789' } });

    const list = await auth(admin).get('/api/admin/supplier-applications?view=all&q=Half%20Done');
    expect(list.body.data.items).toHaveLength(0);
    expect((await auth(admin).get(`/api/admin/supplier-applications/${resumed.id}`)).status).toBe(404);
  });

  it('validates the whole form on submit with field messages', async () => {
    const token = await fixtures.registerUser('ROLE_CUSTOMER');
    const a = auth(token);
    await a.put('/api/seller-onboarding/application', { form: { ...FORM, ein: '123', categories: [] } });
    expect((await a.post('/api/seller-onboarding/application/submit', {})).status).toBe(400);
    const res = await a.post('/api/seller-onboarding/application/submit', { confirm: true });
    expect(res.status).toBe(400);
    expect(res.body.data).toMatchObject({ ein: 'Enter all 9 digits, like 12-3456789', categories: 'Choose at least one category' });
  });

  it('requires sign-in', async () => {
    expect((await request(app).get('/api/seller-onboarding/application')).status).toBe(401);
  });
});

describe('screening', () => {
  it('passes a complete application into the scorecard queue and emails the applicant', async () => {
    const { id, view } = await submitted();
    expect(view).toMatchObject({ stage: 'SCREENED', failedChecks: [] });
    const detail = (await auth(admin).get(`/api/admin/supplier-applications/${id}`)).body.data;
    expect(detail).toMatchObject({ stage: 'SCREENED', view: 'todo', companyName: 'BrightNest Kitchen LLC' });
    expect(detail.screening.every((c: { passed: boolean }) => c.passed)).toBe(true);
    const mail = await prisma.notification.findFirst({ where: { toAddress: detail.email, template: 'SELLER_APPLICATION' } });
    expect(mail?.subject).toContain('received');
  });

  it('auto-rejects failed critical checks, lets the applicant change answers, and lets an admin override', async () => {
    const { token, id, view } = await submitted({ ...FORM, usWarehouse: 'no', shipsAllStates: 'no' });
    expect(view.stage).toBe('AUTO_REJECTED');
    expect(view.failedChecks).toEqual(['You don’t ship from a US warehouse', 'You can’t ship to all 50 states']);

    // Changing answers puts it back in draft.
    const edited = await auth(token).put('/api/seller-onboarding/application', { step: 2 });
    expect(edited.body.data.stage).toBe('DRAFT');
    const resubmitted = await auth(token).post('/api/seller-onboarding/application/submit', { confirm: true });
    expect(resubmitted.body.data.stage).toBe('AUTO_REJECTED');

    const over = await auth(admin).post(`/api/admin/supplier-applications/${id}/override-screening`);
    expect(over.status).toBe(200);
    expect(over.body.data).toMatchObject({ stage: 'SCREENED', screeningOverriddenBy: expect.stringContaining('@') });
    // Submitted: the applicant can no longer edit.
    expect((await auth(token).put('/api/seller-onboarding/application', { step: 1 })).status).toBe(409);
  });
});

describe('scorecard and decisions', () => {
  it('weights the scorecard, enforces the pass mark and accepts an override', async () => {
    const { id } = await submitted();
    const adm = auth(admin);
    const partial = await adm.put(`/api/admin/supplier-applications/${id}/scorecard`, { scores: { fit: 2 } });
    expect(partial.body.data).toMatchObject({ stage: 'SCORECARD', score: null });
    expect((await adm.post(`/api/admin/supplier-applications/${id}/pass`)).status).toBe(409);

    const low = await adm.put(`/api/admin/supplier-applications/${id}/scorecard`, { scores: { fit: 2, data: 2, price: 3, ship: 3, quality: 3, stable: 3 } });
    expect(low.body.data.score).toBe(51);
    expect((await adm.post(`/api/admin/supplier-applications/${id}/pass`)).body.message).toContain('below the pass mark');

    expect((await adm.put(`/api/admin/supplier-applications/${id}/score-override`, { score: 75 })).status).toBe(400);
    const over = await adm.put(`/api/admin/supplier-applications/${id}/score-override`, { score: 75, reason: 'Strong references from buyers' });
    expect(over.body.data).toMatchObject({ score: 75, scorecard: { computed: 51, override: 75 } });
    const passed = await adm.post(`/api/admin/supplier-applications/${id}/pass`);
    expect(passed.status).toBe(200);
    expect(passed.body.data).toMatchObject({ stage: 'DOCUMENTS', view: 'docs' });
  });

  it('declines with a reason the applicant sees, and reopens', async () => {
    const { token, id } = await submitted();
    const adm = auth(admin);
    expect((await adm.post(`/api/admin/supplier-applications/${id}/decline`, { reason: '' })).status).toBe(400);
    const declined = await adm.post(`/api/admin/supplier-applications/${id}/decline`, { reason: 'Product data not ready for our catalog.' });
    expect(declined.body.data).toMatchObject({ stage: 'DECLINED', view: 'closed' });
    expect((await auth(token).get('/api/seller-onboarding/application')).body.data).toMatchObject({
      stage: 'DECLINED',
      declineReason: 'Product data not ready for our catalog.',
    });
    expect((await adm.post(`/api/admin/supplier-applications/${id}/reopen`)).body.data.stage).toBe('SCREENED');
  });

  it('is admin only', async () => {
    const { token, id } = await submitted();
    expect((await auth(token).get('/api/admin/supplier-applications')).status).toBe(403);
    expect((await auth(merchant).post(`/api/admin/supplier-applications/${id}/pass`)).status).toBe(403);
  });
});

describe('documents and approval', () => {
  it('refuses applicant uploads before the scorecard passes', async () => {
    const { token } = await submitted();
    expect((await auth(token).upload('/api/seller-onboarding/documents', 'W9', 'w9.pdf', '%PDF')).status).toBe(409);
  });

  it('verifies documents, asks again, and approval grants ROLE_MERCHANT', async () => {
    const { token, id } = await atDocuments();
    const user = await userOf(token);
    expect(user.role).toBe('ROLE_CUSTOMER');
    const adm = auth(admin);

    const ids = await uploadAll(token);
    const listed = (await auth(token).get('/api/seller-onboarding/documents')).body.data;
    expect(listed).toHaveLength(3);
    expect(listed[0]).toMatchObject({ status: 'PENDING', note: null, label: expect.any(String), fileName: expect.any(String) });
    expect((await adm.get(`/api/admin/supplier-applications/${id}`)).body.data.view).toBe('todo');

    // Not every document verified yet.
    expect((await adm.post(`/api/admin/supplier-applications/${id}/approve`, { resaleCertificate: true })).status).toBe(409);

    const rej = await adm.post(`/api/admin/supplier-applications/${id}/documents/${ids.W9}/reject`, { note: 'Signature missing on page 2' });
    expect(rej.body.data.documents.find((d: { type: string }) => d.type === 'W9')).toMatchObject({ status: 'REJECTED', note: 'Signature missing on page 2' });
    const reupload = await auth(token).upload('/api/seller-onboarding/documents', 'w9', 'w9-signed.pdf', '%PDF signed');
    expect(reupload.body.data).toMatchObject({ type: 'W9', status: 'PENDING', fileName: 'w9-signed.pdf' });
    // The old one is superseded: still three current documents.
    expect((await auth(token).get('/api/seller-onboarding/documents')).body.data).toHaveLength(3);

    for (const docId of [reupload.body.data.id, ids.AGREEMENT, ids.INSURANCE]) {
      expect((await adm.post(`/api/admin/supplier-applications/${id}/documents/${docId}/verify`, {})).status).toBe(200);
    }
    const file = await adm.get(`/api/admin/supplier-applications/${id}/documents/${ids.AGREEMENT}/file`);
    expect(file.status).toBe(200);
    expect(file.headers['content-type']).toBe('application/pdf');

    expect((await adm.post(`/api/admin/supplier-applications/${id}/approve`, {})).status).toBe(400);
    const approved = await adm.post(`/api/admin/supplier-applications/${id}/approve`, { resaleCertificate: true });
    expect(approved.status).toBe(200);
    expect(approved.body.data).toMatchObject({ stage: 'APPROVED', view: 'active', resaleCertificateIssuedAt: expect.any(String) });
    expect((await prisma.user.findUniqueOrThrow({ where: { id: user.id } })).role).toBe('ROLE_MERCHANT');
    // Document reviews and the approval land in the audit log.
    const trail = await prisma.auditEvent.findMany({ where: { entityCode: approved.body.data.reference }, orderBy: { seq: 'asc' } });
    expect(trail.map((e) => e.action)).toEqual(expect.arrayContaining(['document.verified', 'document.rejected', 'supplier.approved']));
    expect(trail.find((e) => e.action === 'supplier.approved')).toMatchObject({ category: 'supplier', afterValue: 'APPROVED', sellerId: user.id });
    // The same token now reaches the seller API.
    expect((await auth(token).get('/api/seller/documents')).status).toBe(200);
  });

  it('suspension blocks /api/seller and reinstatement restores it', async () => {
    const { token, id } = await atDocuments();
    const ids = await uploadAll(token);
    const adm = auth(admin);
    for (const docId of Object.values(ids)) await adm.post(`/api/admin/supplier-applications/${id}/documents/${docId}/verify`, {});
    await adm.post(`/api/admin/supplier-applications/${id}/approve`, { resaleCertificate: true });
    expect((await auth(token).get('/api/seller/submissions')).status).toBe(200);

    expect((await adm.post(`/api/admin/supplier-applications/${id}/suspend`, {})).status).toBe(400);
    const suspended = await adm.post(`/api/admin/supplier-applications/${id}/suspend`, { reason: 'Insurance expired' });
    expect(suspended.body.data).toMatchObject({ stage: 'SUSPENDED', suspensionReason: 'Insurance expired' });
    expect((await auth(token).get('/api/seller/submissions')).status).toBe(403);
    expect((await auth(token).get('/api/seller/documents')).status).toBe(403);

    const list = (await adm.get('/api/admin/supplier-applications?view=active')).body.data;
    expect(list.counts.suspended).toBeGreaterThanOrEqual(1);

    expect((await adm.post(`/api/admin/supplier-applications/${id}/reinstate`)).body.data.stage).toBe('APPROVED');
    expect((await auth(token).get('/api/seller/submissions')).status).toBe(200);
  });

  it('approving a lead from the old form creates the account and emails a set-password link', async () => {
    const email = `lead-${randomUUID()}@test.local`;
    const posted = await request(app).post('/api/seller-applications').send({
      fullName: 'Lead Person',
      email,
      phone: '(503) 555-0199',
      categories: ['Home'],
      products: 'Linen throws',
      street: '1 Main St',
      city: 'Portland',
      state: 'OR',
      postalCode: '97201',
      consent: true,
    });
    expect(posted.status).toBe(201);
    const row = await prisma.sellerApplication.findFirstOrThrow({ where: { email } });
    expect(row.stage).toBe('APPLIED');
    const adm = auth(admin);
    await adm.put(`/api/admin/supplier-applications/${row.id}/scorecard`, { scores: ALL_FIVES });
    expect((await adm.post(`/api/admin/supplier-applications/${row.id}/pass`)).status).toBe(200);

    const user = await prisma.user.findUniqueOrThrow({ where: { email } });
    expect(user.role).toBe('ROLE_CUSTOMER');
    const reset = await prisma.notification.findFirst({ where: { toAddress: email, template: 'PASSWORD_RESET' } });
    expect(reset?.body).toContain('/reset-password?token=');

    // The lead signs in (here: a token for the created account) and uploads; approval makes them a seller.
    const docs = await prisma.$transaction(
      ['W9', 'AGREEMENT', 'INSURANCE'].map((type) =>
        prisma.sellerDocument.create({
          data: {
            userId: user.id,
            applicationId: row.id,
            type,
            fileName: `${type}.pdf`,
            contentType: 'application/pdf',
            sizeBytes: 4,
            content: Buffer.from('%PDF'),
            expiresAt: type === 'INSURANCE' ? new Date(`${future(200)}T00:00:00Z`) : null,
          },
        }),
      ),
    );
    for (const d of docs) await adm.post(`/api/admin/supplier-applications/${row.id}/documents/${d.id}/verify`, {});
    expect((await adm.post(`/api/admin/supplier-applications/${row.id}/approve`, { resaleCertificate: true })).status).toBe(200);
    expect((await prisma.user.findUniqueOrThrow({ where: { email } })).role).toBe('ROLE_MERCHANT');
  });

  it('reminds the supplier by email', async () => {
    const { id } = await atDocuments();
    const res = await auth(admin).post(`/api/admin/supplier-applications/${id}/remind`, {});
    expect(res.status).toBe(200);
    expect(res.body.data.lastReminderAt).toEqual(expect.any(String));
    const mail = await prisma.notification.findFirst({ where: { toAddress: res.body.data.email, subject: { contains: 'documents we still need' } } });
    expect(mail?.body).toContain('W-9 form: not uploaded yet');
  });
});

describe('seller documents API', () => {
  it('uploads, lists and downloads for the signed-in seller only', async () => {
    const m = auth(merchant);
    const up = await m.upload('/api/seller/documents', 'INSURANCE', 'coi.pdf', '%PDF coi', future(100));
    expect(up.status).toBe(201);
    expect(up.body.data).toMatchObject({
      type: 'INSURANCE',
      label: 'Certificate of insurance',
      fileName: 'coi.pdf',
      status: 'PENDING',
      expiresAt: future(100),
      note: null,
      uploadedAt: expect.any(String),
    });
    const second = await m.upload('/api/seller/documents', 'INSURANCE', 'coi-2.pdf', '%PDF coi 2', future(200));
    const list = (await m.get('/api/seller/documents')).body.data;
    expect(list.map((d: { id: string }) => d.id)).toEqual([second.body.data.id]);

    const file = await m
      .get(`/api/seller/documents/${second.body.data.id}/file`)
      .buffer(true)
      .parse((res, cb) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => cb(null, Buffer.concat(chunks)));
      });
    expect(file.status).toBe(200);
    expect(file.headers['content-disposition']).toContain('coi-2.pdf');
    expect((file.body as Buffer).toString()).toBe('%PDF coi 2');

    // Someone else's document is not found; non-sellers are refused.
    expect((await auth(otherMerchant).get(`/api/seller/documents/${second.body.data.id}/file`)).status).toBe(404);
    expect((await auth(otherMerchant).get('/api/seller/documents')).body.data).toEqual([]);
    const customer = await fixtures.registerUser('ROLE_CUSTOMER');
    expect((await auth(customer).get('/api/seller/documents')).status).toBe(403);
    expect((await request(app).get('/api/seller/documents')).status).toBe(401);
  });

  it('validates type, file type and expiry', async () => {
    const m = auth(merchant);
    expect((await m.upload('/api/seller/documents', 'PASSPORT', 'x.pdf', '%PDF')).status).toBe(400);
    expect((await m.upload('/api/seller/documents', 'W9', 'x.exe', 'MZ')).body.data).toMatchObject({ file: expect.stringContaining('PDF, JPG or PNG') });
    expect((await m.upload('/api/seller/documents', 'INSURANCE', 'x.pdf', '%PDF', '2020-01-01')).status).toBe(400);
    expect((await m.post('/api/seller/documents', { type: 'W9' })).status).toBe(415);
  });

  it('serves the seller agreement', async () => {
    const res = await auth(merchant).get('/api/seller/agreement');
    expect(res.status).toBe(200);
    expect(res.headers['content-disposition']).toContain('seller-agreement');
    expect(res.text).toContain('Seller Agreement');
  });
});
