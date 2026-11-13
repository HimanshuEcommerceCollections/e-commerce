import { randomBytes, randomInt } from 'node:crypto';
import { Prisma, type PrismaClient, type SellerApplication, type SellerDocument, type User } from '@prisma/client';
import type { z } from 'zod';
import type { AuthService } from '../auth/auth.service';
import { hashPassword } from '../auth/auth.service';
import { isIntegrityViolation } from '../common/error-handler';
import { DomainError } from '../common/errors';
import { logger } from '../common/logger';
import { withUniqueReference } from '../common/reference';
import { ValidationError } from '../common/validation';
import type { Config } from '../config';
import { TX } from '../db';
import type { Mailer } from '../notify/mailer';
import type { AuditInput, AuditService } from '../audit/audit.service';
import {
  ApplicationFormSchema,
  DOCUMENT_CONTENT_TYPES,
  DOCUMENT_TYPES,
  EXPIRY_WARNING_DAYS,
  MAX_DOCUMENT_BYTES,
  PRODUCT_DATA_LABEL,
  SCORECARD,
  SCORE_PASS_MARK,
  SCORING_STAGES,
  SUSPENSION_REASONS,
  documentLabel,
  formErrors,
  screen,
  weightedScore,
  type ApplicationForm,
  type ApproveSchema,
  type DeclineSchema,
  type DocumentRejectSchema,
  type DocumentReviewSchema,
  type DocumentStatus,
  type DocumentType,
  type RemindSchema,
  type SaveDraftSchema,
  type ScoreOverrideSchema,
  type ScorecardSchema,
  type ScreeningCheck,
  type Scores,
  type SupplierStage,
  type SupplierView,
  type SuspendSchema,
} from './onboarding.rules';
import { SELLER_AGREEMENT_FILE_NAME, sellerAgreementHtml } from './seller-agreement';

const log = logger('supplier');

/** Document metadata: never the file bytes, which are read only for a download. */
const DOC_META = {
  id: true,
  createdAt: true,
  updatedAt: true,
  userId: true,
  applicationId: true,
  type: true,
  fileName: true,
  contentType: true,
  sizeBytes: true,
  status: true,
  expiresAt: true,
  note: true,
  reviewedBy: true,
  reviewedAt: true,
  supersededAt: true,
} satisfies Prisma.SellerDocumentSelect;
type DocMeta = Omit<SellerDocument, 'content'>;

const CURRENT = { supersededAt: null } as const;

export interface UploadedFile {
  originalname: string;
  mimetype: string;
  size: number;
  buffer: Buffer;
}

export interface DownloadFile {
  fileName: string;
  contentType: string;
  content: Buffer;
}

const conflict = (message: string) => new DomainError(409, message);
const notFound = (what: string) => new DomainError(404, `${what} was not found`);

const today = () => new Date().toISOString().slice(0, 10);
const dateOnly = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : null);
const daysUntil = (d: Date) => Math.round((d.getTime() - Date.parse(`${today()}T00:00:00Z`)) / 86_400_000);

function parseDate(value: string, field: string): Date {
  const d = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== value) throw new ValidationError({ [field]: 'Enter a valid date' });
  return d;
}

/** VERIFIED or PENDING documents whose expiry date has passed read as EXPIRED. */
function effectiveStatus(d: Pick<DocMeta, 'status' | 'expiresAt'>): DocumentStatus {
  if (d.status !== 'REJECTED' && d.expiresAt && dateOnly(d.expiresAt)! < today()) return 'EXPIRED';
  return d.status as DocumentStatus;
}

export const toDocument = (d: DocMeta) => ({
  id: d.id,
  type: d.type,
  label: documentLabel(d.type),
  fileName: d.fileName,
  contentType: d.contentType,
  sizeBytes: d.sizeBytes,
  status: effectiveStatus(d),
  expiresAt: dateOnly(d.expiresAt),
  uploadedAt: d.createdAt,
  note: d.note,
  reviewedBy: d.reviewedBy,
  reviewedAt: d.reviewedAt,
});

const formOf = (a: SellerApplication): ApplicationForm => (a.form ?? {}) as ApplicationForm;
const scoresOf = (a: SellerApplication): Scores => (a.scores ?? {}) as Scores;
const screeningOf = (a: SellerApplication): ScreeningCheck[] => (a.screening ?? []) as unknown as ScreeningCheck[];
const effectiveScore = (a: SellerApplication) => a.scoreOverride ?? a.score;

type AppWithDocs = SellerApplication & { documents: DocMeta[] };

/** Which admin view an application sits in. Documents with a pending upload need the team; otherwise the supplier. */
function viewOf(a: SellerApplication, docs: DocMeta[]): SupplierView | 'draft' {
  const stage = a.stage as SupplierStage;
  if (stage === 'DRAFT') return 'draft';
  if (SCORING_STAGES.includes(stage)) return 'todo';
  if (stage === 'DOCUMENTS') return docs.some((d) => effectiveStatus(d) === 'PENDING') ? 'todo' : 'docs';
  if (stage === 'APPROVED' || stage === 'SUSPENDED') return 'active';
  return 'closed';
}

/**
 * Supplier onboarding (designs: seller-portal-application, catalog-supplier-approvals).
 *
 * Applicants sign in with an ordinary customer account, fill the application
 * as a server-side draft and submit it; screening runs on submit. The
 * catalog team scores it (SUP-001), asks for documents, verifies them and
 * approves, which turns the account into a ROLE_MERCHANT seller. Suspension
 * takes ROLE_MERCHANT away (so every /api/seller route answers 403) and
 * reinstatement gives it back.
 */
export class SupplierOnboardingService {
  private readonly storeName: string;
  private readonly appBaseUrl: string;

  constructor(
    private readonly prisma: PrismaClient,
    private readonly mailer: Mailer,
    private readonly auth: AuthService,
    config: Config,
    private readonly audit?: AuditService,
  ) {
    this.storeName = config.store.name;
    this.appBaseUrl = config.store.appBaseUrl;
  }

  // ── Applicant ─────────────────────────────────────────────────────────────

  async getMine(user: User) {
    const app = await this.prisma.sellerApplication.findUnique({
      where: { userId: user.id },
      include: { documents: { where: CURRENT, select: DOC_META, orderBy: { createdAt: 'asc' } } },
    });
    return app ? this.applicantView(app) : null;
  }

  /** Creates the draft on first save; afterwards updates it. An auto-rejected application goes back to draft. */
  async saveDraft(user: User, input: z.output<typeof SaveDraftSchema>) {
    let app = await this.prisma.sellerApplication.findUnique({ where: { userId: user.id } });
    if (!app) app = await this.createDraft(user, input.companyName);
    if (app.stage !== 'DRAFT' && app.stage !== 'AUTO_REJECTED') {
      throw conflict('Your application has already been submitted');
    }
    const form = input.form ? { ...formOf(app), ...stripUndefined(input.form) } : formOf(app);
    await this.prisma.sellerApplication.update({
      where: { id: app.id },
      data: {
        form: form as Prisma.InputJsonValue,
        ...(input.step !== undefined && { formStep: input.step }),
        ...(input.companyName?.trim() && { companyName: input.companyName.trim() }),
        ...(app.stage === 'AUTO_REJECTED' && {
          stage: 'DRAFT',
          status: 'NEW',
          screening: Prisma.DbNull,
          screenedAt: null,
          stageChangedAt: new Date(),
        }),
        updatedAt: new Date(),
      },
    });
    return (await this.getMine(user))!;
  }

  private async createDraft(user: User, companyName: string | undefined) {
    try {
      return await withUniqueReference(
        () => `SA-${randomInt(10_000, 100_000)}`,
        (reference) =>
          this.prisma.sellerApplication.create({
            data: {
              reference,
              userId: user.id,
              stage: 'DRAFT',
              stageChangedAt: new Date(),
              companyName: companyName?.trim() || null,
              fullName: user.fullName,
              email: user.email,
              // Filled from the form on submit.
              phone: '',
              categories: [],
              products: '',
              street: '',
              city: '',
              state: '',
              postalCode: '',
            },
          }),
      );
    } catch (e) {
      // A concurrent first save created it.
      if (!isIntegrityViolation(e)) throw e;
      return this.prisma.sellerApplication.findUniqueOrThrow({ where: { userId: user.id } });
    }
  }

  async submit(user: User) {
    const app = await this.prisma.sellerApplication.findUnique({ where: { userId: user.id } });
    if (!app) throw notFound('Your application');
    if (app.stage !== 'DRAFT') throw conflict('Your application has already been submitted');
    const form = ApplicationFormSchema.parse(formOf(app));
    const errors = formErrors(form);
    if (Object.keys(errors).length) throw new ValidationError(errors);

    const checks = screen(form);
    const passed = checks.every((c) => c.passed);
    const now = new Date();
    const updated = await this.prisma.sellerApplication.update({
      where: { id: app.id },
      data: {
        stage: passed ? 'SCREENED' : 'AUTO_REJECTED',
        status: passed ? 'NEW' : 'REJECTED',
        stageChangedAt: now,
        submittedAt: now,
        screening: checks as unknown as Prisma.InputJsonValue,
        screenedAt: now,
        consentAt: now,
        companyName: form.legalName!.trim(),
        fullName: user.fullName,
        email: user.email,
        phone: form.phone!.trim(),
        categories: form.categories!,
        products: [`Products to list: ${form.productCount}`, `Brands: ${form.brands!.trim()}`, form.notes?.trim()].filter(Boolean).join('\n').slice(0, 2000),
        street: form.street!.trim(),
        city: form.city!.trim(),
        state: form.state!.toUpperCase(),
        postalCode: form.zip!,
        formStep: 4,
        updatedAt: now,
      },
    });
    const company = updated.companyName ?? updated.fullName;
    if (passed) {
      await this.mail(updated, `application ${updated.reference} received`,
        `Hi ${updated.fullName}, thanks for applying to sell with ${this.storeName}.\n\n` +
          `Our catalog manager will review ${company} with our supplier scorecard and email you when there’s an update. ` +
          `Your reference is ${updated.reference}.`);
    } else {
      await this.mail(updated, `we can’t approve application ${updated.reference}`,
        `Hi ${updated.fullName}, based on your answers ${company} doesn’t meet our requirements right now:\n\n` +
          checks.filter((c) => !c.passed).map((c) => `- ${c.reason}`).join('\n') +
          `\n\nIf this isn’t right, sign in and change your answers: ${this.appBaseUrl}/sell/apply`);
    }
    return (await this.getMine(user))!;
  }

  private applicantView(a: AppWithDocs) {
    const stage = a.stage as SupplierStage;
    return {
      id: a.id,
      reference: a.reference,
      stage,
      companyName: a.companyName,
      contactName: a.fullName,
      email: a.email,
      step: a.formStep,
      form: formOf(a),
      submittedAt: a.submittedAt,
      updatedAt: a.updatedAt ?? a.createdAt,
      failedChecks: screeningOf(a).filter((c) => !c.passed).map((c) => c.reason),
      // Only outcomes the applicant is told about; scores and notes stay internal.
      declineReason: stage === 'DECLINED' ? a.declineReason : null,
      suspensionReason: stage === 'SUSPENDED' ? a.suspensionReason : null,
      documents: a.documents.map(toDocument),
      requiredDocuments: DOCUMENT_TYPES.map((d) => ({ type: d.type, label: d.label, expires: d.expires })),
    };
  }

  // ── Documents (applicant and seller) ──────────────────────────────────────

  async listDocuments(userId: string) {
    const docs = await this.prisma.sellerDocument.findMany({
      where: { userId, ...CURRENT },
      select: DOC_META,
      orderBy: { createdAt: 'asc' },
    });
    return docs.map(toDocument);
  }

  /** Applicants may upload once their application has passed the scorecard. */
  async assertCanUploadAsApplicant(user: User) {
    const app = await this.prisma.sellerApplication.findUnique({ where: { userId: user.id }, select: { stage: true } });
    if (!app || !['DOCUMENTS', 'APPROVED', 'SUSPENDED'].includes(app.stage)) {
      throw conflict('Documents are requested once your application passes our review');
    }
  }

  /** Adds a document; it supersedes the previous one of that type and waits for review (PENDING). */
  async uploadDocument(user: User, rawType: unknown, file: UploadedFile | undefined, rawExpiresAt: unknown) {
    const type = parseDocumentType(rawType);
    if (!file) throw new ValidationError({ file: 'Choose a file' });
    const fileName = cleanFileName(file.originalname);
    const ext = fileName.split('.').pop()?.toLowerCase() ?? '';
    const contentType = DOCUMENT_CONTENT_TYPES[ext];
    if (!contentType) throw new ValidationError({ file: 'That file type isn’t accepted. Upload a PDF, JPG or PNG.' });
    if (file.size === 0) throw new ValidationError({ file: 'The file is empty' });
    if (file.size > MAX_DOCUMENT_BYTES) throw new DomainError(413, 'The uploaded file is too large');
    let expiresAt: Date | null = null;
    if (typeof rawExpiresAt === 'string' && rawExpiresAt.trim()) {
      expiresAt = parseDate(rawExpiresAt.trim(), 'expiresAt');
      if (dateOnly(expiresAt)! <= today()) {
        throw new ValidationError({ expiresAt: 'This certificate has already expired. Upload a current one.' });
      }
    }

    const app = await this.prisma.sellerApplication.findUnique({ where: { userId: user.id }, select: { id: true } });
    try {
      const doc = await this.prisma.$transaction(async (tx) => {
        await tx.sellerDocument.updateMany({ where: { userId: user.id, type, ...CURRENT }, data: { supersededAt: new Date() } });
        return tx.sellerDocument.create({
          data: {
            userId: user.id,
            applicationId: app?.id ?? null,
            type,
            fileName,
            contentType,
            sizeBytes: file.size,
            content: new Uint8Array(file.buffer),
            status: 'PENDING',
            expiresAt,
          },
          select: DOC_META,
        });
      }, TX.default);
      return toDocument(doc);
    } catch (e) {
      if (isIntegrityViolation(e)) throw conflict('Another upload of this document is in progress. Try again.');
      throw e;
    }
  }

  /** A document's file, for its owner only (any version they uploaded). */
  async ownDocumentFile(userId: string, id: string): Promise<DownloadFile> {
    const doc = await this.prisma.sellerDocument.findFirst({
      where: { id, userId },
      select: { fileName: true, contentType: true, content: true },
    });
    if (!doc) throw notFound(`Document ${id}`);
    return { fileName: doc.fileName, contentType: doc.contentType, content: Buffer.from(doc.content) };
  }

  agreement(): DownloadFile {
    return {
      fileName: SELLER_AGREEMENT_FILE_NAME,
      contentType: 'text/html; charset=utf-8',
      content: Buffer.from(sellerAgreementHtml(this.storeName), 'utf8'),
    };
  }

  // ── Admin: queue ──────────────────────────────────────────────────────────

  async list(filter: { view?: SupplierView; stage?: SupplierStage; q?: string }) {
    const q = filter.q?.trim();
    const rows = await this.prisma.sellerApplication.findMany({
      where: {
        stage: filter.stage ?? { not: 'DRAFT' },
        ...(q && {
          OR: (['companyName', 'fullName', 'email', 'reference'] as const).map((f) => ({
            [f]: { contains: q, mode: 'insensitive' as const },
          })),
        }),
      },
      include: { documents: { where: CURRENT, select: DOC_META } },
      orderBy: [{ submittedAt: 'asc' }, { createdAt: 'asc' }],
      take: 1000,
    });
    const items = rows.map((a) => ({ a, view: viewOf(a, a.documents) }));
    const counts = { todo: 0, docs: 0, active: 0, suspended: 0, closed: 0, all: items.length, expiring: 0 };
    for (const { a, view } of items) {
      if (view !== 'draft') counts[view]++;
      if (a.stage === 'SUSPENDED') counts.suspended++;
    }
    const expiring = items
      .filter(({ a }) => a.stage === 'APPROVED')
      .map(({ a }) => ({ a, insurance: a.documents.find((d) => d.type === 'INSURANCE' && d.expiresAt) }))
      .filter(({ insurance }) => insurance && daysUntil(insurance.expiresAt!) <= EXPIRY_WARNING_DAYS)
      .map(({ a, insurance }) => ({
        id: a.id,
        companyName: a.companyName ?? a.fullName,
        expiresAt: dateOnly(insurance!.expiresAt),
        days: daysUntil(insurance!.expiresAt!),
      }));
    counts.expiring = expiring.length;
    return {
      counts,
      expiring,
      items: items.filter(({ view }) => !filter.view || filter.view === 'all' || view === filter.view).map(({ a, view }) => this.listRow(a, view)),
    };
  }

  private listRow(a: AppWithDocs, view: SupplierView | 'draft') {
    const form = formOf(a);
    const insurance = a.documents.find((d) => d.type === 'INSURANCE');
    return {
      id: a.id,
      reference: a.reference,
      stage: a.stage as SupplierStage,
      view,
      documentsToVerify: a.documents.filter((d) => effectiveStatus(d) === 'PENDING').length,
      companyName: a.companyName ?? a.fullName,
      contactName: a.fullName,
      email: a.email,
      categories: a.categories,
      usWarehouse: form.usWarehouse ?? null,
      warehouseState: form.warehouseState ?? null,
      score: effectiveScore(a),
      documentsUploaded: a.documents.filter((d) => effectiveStatus(d) !== 'REJECTED').length,
      documentsRequired: DOCUMENT_TYPES.length,
      insuranceExpiresAt: dateOnly(insurance?.expiresAt ?? null),
      submittedAt: a.submittedAt ?? a.createdAt,
    };
  }

  async get(id: string) {
    const a = await this.load(id);
    const form = formOf(a);
    const view = viewOf(a, a.documents);
    const user = a.userId ? await this.prisma.user.findUnique({ where: { id: a.userId }, select: { role: true, email: true } }) : null;
    return {
      ...this.listRow(a, view),
      createdAt: a.createdAt,
      updatedAt: a.updatedAt,
      stageChangedAt: a.stageChangedAt,
      phone: a.phone,
      address: [a.street, a.city, a.state, a.postalCode].filter(Boolean).join(', '),
      legacyProducts: a.products,
      form,
      productDataLabel: form.productData ? PRODUCT_DATA_LABEL[form.productData as keyof typeof PRODUCT_DATA_LABEL] ?? form.productData : null,
      hasForm: Object.keys(form).length > 0,
      account: user ? { exists: true, role: user.role } : { exists: false, role: null },
      screening: screeningOf(a),
      screenedAt: a.screenedAt,
      screeningOverriddenBy: a.screeningOverriddenBy,
      screeningOverriddenAt: a.screeningOverriddenAt,
      scorecard: {
        criteria: SCORECARD,
        passMark: SCORE_PASS_MARK,
        scores: scoresOf(a),
        computed: a.score,
        override: a.scoreOverride,
        overrideReason: a.scoreOverrideReason,
        note: a.scoreNote,
        scoredBy: a.scoredBy,
        scoredAt: a.scoredAt,
      },
      documents: a.documents.map(toDocument),
      requiredDocuments: DOCUMENT_TYPES.map((d) => ({ type: d.type, label: d.label, expires: d.expires })),
      declineReason: a.declineReason,
      declinedBy: a.declinedBy,
      declinedAt: a.declinedAt,
      approvedBy: a.approvedBy,
      approvedAt: a.approvedAt,
      resaleCertificateIssuedAt: a.resaleCertificateIssuedAt,
      suspensionReason: a.suspensionReason,
      suspendedBy: a.suspendedBy,
      suspendedAt: a.suspendedAt,
      reinstatedAt: a.reinstatedAt,
      lastReminderAt: a.lastReminderAt,
      suspensionReasons: SUSPENSION_REASONS,
      adminNote: a.adminNote,
    };
  }

  private async load(id: string): Promise<AppWithDocs> {
    const a = await this.prisma.sellerApplication.findUnique({
      where: { id },
      include: { documents: { where: CURRENT, select: DOC_META, orderBy: { createdAt: 'asc' } } },
    });
    if (!a || a.stage === 'DRAFT') throw notFound(`Seller application ${id}`);
    // Documents belong to the account; ones uploaded before the application was linked still count.
    if (a.userId) {
      a.documents = await this.prisma.sellerDocument.findMany({ where: { userId: a.userId, ...CURRENT }, select: DOC_META, orderBy: { createdAt: 'asc' } });
    }
    return a;
  }

  private async move(a: SellerApplication, from: readonly string[], data: Prisma.SellerApplicationUpdateInput, what: string) {
    if (!from.includes(a.stage)) throw conflict(`Can't ${what} an application at stage ${a.stage}`);
    const { count } = await this.prisma.sellerApplication.updateMany({
      where: { id: a.id, stage: a.stage },
      data: { ...(data as Prisma.SellerApplicationUpdateManyMutationInput), updatedAt: new Date() },
    });
    if (count === 0) throw conflict('The application changed meanwhile. Reload and try again.');
  }

  // ── Admin: scorecard ──────────────────────────────────────────────────────

  async saveScorecard(id: string, input: z.output<typeof ScorecardSchema>, admin: string) {
    const a = await this.load(id);
    const scores: Scores = { ...scoresOf(a) };
    for (const c of SCORECARD) {
      const v = input.scores[c.key];
      if (v === null) delete scores[c.key];
      else if (v !== undefined) scores[c.key] = v;
    }
    await this.move(a, SCORING_STAGES, {
      scores: scores as Prisma.InputJsonValue,
      score: weightedScore(scores),
      ...(input.note !== undefined && { scoreNote: input.note.trim() || null }),
      scoredBy: admin,
      scoredAt: new Date(),
      ...(a.stage !== 'SCORECARD' && { stage: 'SCORECARD', stageChangedAt: new Date() }),
    }, 'score');
    await this.trail(a, admin, 'supplier.scored', 'Scorecard saved', { after: `Score ${weightedScore(scores) ?? '–'}`, note: input.note?.trim() || null });
    return this.get(id);
  }

  async overrideScore(id: string, input: z.output<typeof ScoreOverrideSchema>, admin: string) {
    const a = await this.load(id);
    await this.move(a, SCORING_STAGES, {
      scoreOverride: input.score,
      scoreOverrideReason: input.score === null ? null : input.reason!.trim(),
      scoredBy: admin,
      scoredAt: new Date(),
      ...(a.stage !== 'SCORECARD' && { stage: 'SCORECARD', stageChangedAt: new Date() }),
    }, 'score');
    await this.trail(a, admin, input.score === null ? 'supplier.score_override_cleared' : 'supplier.score_overridden', input.score === null ? 'Score override cleared' : 'Score overridden', { after: input.score === null ? null : `Score ${input.score}`, note: input.score === null ? null : input.reason!.trim() });
    return this.get(id);
  }

  /** Passes the scorecard and asks for documents. A lead without an account gets one (set-password link). */
  async pass(id: string, admin: string) {
    const a = await this.load(id);
    const total = effectiveScore(a);
    if (!SCORING_STAGES.includes(a.stage as SupplierStage)) throw conflict(`Can't pass an application at stage ${a.stage}`);
    if (total === null) throw conflict('Score every criterion first');
    if (total < SCORE_PASS_MARK) throw conflict(`The score (${total}) is below the pass mark of ${SCORE_PASS_MARK}`);
    const { user, created } = await this.ensureUser(a, 'ROLE_CUSTOMER');
    await this.move(a, SCORING_STAGES, {
      stage: 'DOCUMENTS',
      stageChangedAt: new Date(),
      ...(a.scoredBy === null && { scoredBy: admin, scoredAt: new Date() }),
    }, 'pass');
    if (created) await this.auth.requestPasswordReset({ email: user.email });
    await this.mail(a, 'your application passed. Upload your documents',
      `Good news, ${a.fullName}: ${a.companyName ?? 'your application'} passed our review.\n\n` +
        `One last step: upload your W-9, the signed seller agreement and your certificate of insurance, then we’ll activate your account.\n` +
        `${this.appBaseUrl}/sell/apply` +
        (created ? `\n\nWe’ve created an account for ${user.email}. Use the separate email we sent to choose your password.` : ''));
    await this.trail(a, admin, 'supplier.passed', 'Scorecard passed, documents requested', { before: a.stage, after: 'DOCUMENTS', note: `Score ${total}${created ? '; account created' : ''}` });
    return this.get(id);
  }

  async decline(id: string, input: z.output<typeof DeclineSchema>, admin: string) {
    const a = await this.load(id);
    await this.move(a, [...SCORING_STAGES, 'DOCUMENTS', 'AUTO_REJECTED'], {
      stage: 'DECLINED',
      status: 'REJECTED',
      stageChangedAt: new Date(),
      declineReason: input.reason,
      declinedBy: admin,
      declinedAt: new Date(),
      handledBy: admin,
    }, 'decline');
    await this.mail(a, `update on application ${a.reference}`,
      `Hi ${a.fullName}, thank you for applying to sell with ${this.storeName}. We can’t approve ${a.companyName ?? 'your application'} right now.\n\n` +
        `Reason: ${input.reason}`);
    await this.trail(a, admin, 'supplier.declined', 'Supplier declined', { before: a.stage, after: 'DECLINED', note: input.reason });
    return this.get(id);
  }

  async reopen(id: string, admin: string) {
    const a = await this.load(id);
    const scored = Object.keys(scoresOf(a)).length > 0 || a.scoreOverride !== null;
    await this.move(a, ['DECLINED'], {
      stage: scored ? 'SCORECARD' : a.submittedAt && a.screening ? 'SCREENED' : 'APPLIED',
      status: 'NEW',
      stageChangedAt: new Date(),
      declineReason: null,
      handledBy: admin,
    }, 'reopen');
    await this.trail(a, admin, 'supplier.reopened', 'Application reopened', { before: 'DECLINED' });
    return this.get(id);
  }

  /** "Override and score anyway": recorded with the admin's name. */
  async overrideScreening(id: string, admin: string) {
    const a = await this.load(id);
    await this.move(a, ['AUTO_REJECTED'], {
      stage: 'SCREENED',
      status: 'NEW',
      stageChangedAt: new Date(),
      screeningOverriddenBy: admin,
      screeningOverriddenAt: new Date(),
    }, 'override');
    await this.trail(a, admin, 'supplier.screening_overridden', 'Screening overridden', { before: 'AUTO_REJECTED', after: 'SCREENED' });
    return this.get(id);
  }

  // ── Admin: documents ──────────────────────────────────────────────────────

  private async adminDocument(id: string, docId: string) {
    const a = await this.load(id);
    const doc = a.documents.find((d) => d.id === docId);
    if (!doc) throw notFound(`Document ${docId}`);
    return { a, doc };
  }

  async verifyDocument(id: string, docId: string, input: z.output<typeof DocumentReviewSchema>, admin: string) {
    const { a, doc } = await this.adminDocument(id, docId);
    const expiresAt = input.expiresAt ? parseDate(input.expiresAt, 'expiresAt') : doc.expiresAt;
    if (DOCUMENT_TYPES.find((t) => t.type === doc.type)?.expires && !expiresAt) {
      throw new ValidationError({ expiresAt: 'Add the expiry date before verifying' });
    }
    if (expiresAt && dateOnly(expiresAt)! < today()) throw conflict('This document has expired. Ask the supplier for a current one.');
    await this.prisma.sellerDocument.update({
      where: { id: doc.id },
      data: { status: 'VERIFIED', expiresAt, note: null, reviewedBy: admin, reviewedAt: new Date() },
    });
    await this.trail(a, admin, 'document.verified', `${documentLabel(doc.type)} verified`, { doc, before: doc.status, after: 'VERIFIED', ...(expiresAt && { note: `Expires ${dateOnly(expiresAt)}` }) });
    return this.get(id);
  }

  /** "Ask again": the supplier is emailed what to fix. */
  async rejectDocument(id: string, docId: string, input: z.output<typeof DocumentRejectSchema>, admin: string) {
    const { a, doc } = await this.adminDocument(id, docId);
    await this.prisma.sellerDocument.update({
      where: { id: doc.id },
      data: { status: 'REJECTED', note: input.note, reviewedBy: admin, reviewedAt: new Date() },
    });
    await this.mail(a, `please upload your ${documentLabel(doc.type)} again`,
      `Hi ${a.fullName}, we couldn’t accept the ${documentLabel(doc.type)} you uploaded (${doc.fileName}).\n\n` +
        `What to fix: ${input.note}\n\nUpload a new copy here: ${this.uploadLink(a)}`);
    await this.trail(a, admin, 'document.rejected', `${documentLabel(doc.type)} sent back`, { doc, before: doc.status, after: 'REJECTED', note: input.note });
    return this.get(id);
  }

  async adminDocumentFile(id: string, docId: string): Promise<DownloadFile> {
    const a = await this.load(id);
    const doc = await this.prisma.sellerDocument.findFirst({
      where: { id: docId, OR: [{ applicationId: a.id }, ...(a.userId ? [{ userId: a.userId }] : [])] },
      select: { fileName: true, contentType: true, content: true },
    });
    if (!doc) throw notFound(`Document ${docId}`);
    return { fileName: doc.fileName, contentType: doc.contentType, content: Buffer.from(doc.content) };
  }

  /** Emails the supplier the documents still missing, rejected or expiring. */
  async remind(id: string, input: z.output<typeof RemindSchema>, admin: string | null = null) {
    const a = await this.load(id);
    if (!['DOCUMENTS', 'APPROVED', 'SUSPENDED'].includes(a.stage)) throw conflict('Documents haven’t been requested yet');
    const lines = DOCUMENT_TYPES.flatMap(({ type, label }) => {
      const d = a.documents.find((x) => x.type === type);
      if (!d) return [`- ${label}: not uploaded yet`];
      const s = effectiveStatus(d);
      if (s === 'REJECTED') return [`- ${label}: please upload it again${d.note ? ` (${d.note})` : ''}`];
      if (s === 'EXPIRED') return [`- ${label}: expired, please upload a current one`];
      if (d.expiresAt && daysUntil(d.expiresAt) <= EXPIRY_WARNING_DAYS) return [`- ${label}: expires ${dateOnly(d.expiresAt)}, please upload a new one`];
      return [];
    });
    await this.mail(a, 'documents we still need',
      `Hi ${a.fullName},\n\n` +
        (input.message?.trim() ? `${input.message.trim()}\n\n` : '') +
        (lines.length ? `We still need:\n${lines.join('\n')}\n\n` : '') +
        `Upload them here: ${this.uploadLink(a)}`);
    await this.prisma.sellerApplication.update({ where: { id: a.id }, data: { lastReminderAt: new Date() } });
    await this.trail(a, admin, 'supplier.reminded', 'Document reminder sent', { note: input.message?.trim() || null });
    return this.get(id);
  }

  private uploadLink(a: SellerApplication) {
    return a.stage === 'DOCUMENTS' ? `${this.appBaseUrl}/sell/apply` : `${this.appBaseUrl}/merchant`;
  }

  // ── Admin: approval, suspension ───────────────────────────────────────────

  /**
   * Activates the supplier: every document verified, Form E-595E issued. The
   * applicant's account becomes ROLE_MERCHANT; when there is none yet, one is
   * created and a set-password link emailed.
   */
  async approve(id: string, _input: z.output<typeof ApproveSchema>, admin: string) {
    const a = await this.load(id);
    if (a.stage !== 'DOCUMENTS') throw conflict(`Can't approve an application at stage ${a.stage}`);
    const missing = DOCUMENT_TYPES.filter(({ type }) => {
      const d = a.documents.find((x) => x.type === type);
      return !d || effectiveStatus(d) !== 'VERIFIED';
    });
    if (missing.length) throw conflict(`Verify every document first: ${missing.map((m) => m.label).join(', ')}`);

    const { user, created } = await this.ensureUser(a, 'ROLE_MERCHANT');
    const now = new Date();
    await this.prisma.$transaction(async (tx) => {
      const { count } = await tx.sellerApplication.updateMany({
        where: { id: a.id, stage: 'DOCUMENTS' },
        data: {
          stage: 'APPROVED',
          status: 'APPROVED',
          stageChangedAt: now,
          userId: user.id,
          approvedBy: admin,
          approvedAt: now,
          resaleCertificateIssuedAt: now,
          handledBy: admin,
          updatedAt: now,
        },
      });
      if (count === 0) throw conflict('The application changed meanwhile. Reload and try again.');
      await grantMerchant(tx, user);
    }, TX.default);

    if (created) await this.auth.requestPasswordReset({ email: user.email });
    await this.mail(a, `${a.companyName ?? 'your business'} is approved`,
      `Welcome to ${this.storeName}, ${a.fullName}! ${a.companyName ?? 'Your business'} is approved and product upload is unlocked.\n\n` +
        `Sign in to the Seller Portal to add your first products: ${this.appBaseUrl}/merchant\n` +
        `Every product is still reviewed by our catalog team before customers see it. Our resale certificate (Form E-595E) follows by email.` +
        (created ? `\n\nWe’ve created your account for ${user.email}. Use the separate email we sent to choose your password.` : ''));
    await this.trail(a, admin, 'supplier.approved', 'Supplier approved, seller access granted', { before: 'DOCUMENTS', after: 'APPROVED', note: created ? `Account created for ${user.email}` : null });
    return this.get(id);
  }

  /** Takes ROLE_MERCHANT away: every /api/seller route answers 403 until reinstated. */
  async suspend(id: string, input: z.output<typeof SuspendSchema>, admin: string) {
    const a = await this.load(id);
    if (a.stage !== 'APPROVED') throw conflict(`Can't suspend an application at stage ${a.stage}`);
    const now = new Date();
    await this.prisma.$transaction(async (tx) => {
      const { count } = await tx.sellerApplication.updateMany({
        where: { id: a.id, stage: 'APPROVED' },
        data: { stage: 'SUSPENDED', stageChangedAt: now, suspensionReason: input.reason, suspendedBy: admin, suspendedAt: now, handledBy: admin, updatedAt: now },
      });
      if (count === 0) throw conflict('The application changed meanwhile. Reload and try again.');
      if (a.userId) {
        await tx.user.updateMany({ where: { id: a.userId, role: 'ROLE_MERCHANT' }, data: { role: 'ROLE_CUSTOMER' } });
      }
    }, TX.default);
    await this.mail(a, 'your seller account is suspended',
      `Hi ${a.fullName}, we’ve suspended ${a.companyName ?? 'your seller account'} on ${this.storeName}.\n\n` +
        `Reason: ${input.reason}\n\nYou can’t add or change products while suspended. Reply to this email to work with us on reinstatement.`);
    await this.trail(a, admin, 'supplier.suspended', 'Supplier suspended, seller access revoked', { before: 'APPROVED', after: 'SUSPENDED', note: input.reason });
    return this.get(id);
  }

  async reinstate(id: string, admin: string) {
    const a = await this.load(id);
    if (a.stage !== 'SUSPENDED') throw conflict(`Can't reinstate an application at stage ${a.stage}`);
    const now = new Date();
    await this.prisma.$transaction(async (tx) => {
      const { count } = await tx.sellerApplication.updateMany({
        where: { id: a.id, stage: 'SUSPENDED' },
        data: { stage: 'APPROVED', stageChangedAt: now, suspensionReason: null, reinstatedAt: now, handledBy: admin, updatedAt: now },
      });
      if (count === 0) throw conflict('The application changed meanwhile. Reload and try again.');
      if (a.userId) {
        const user = await tx.user.findUniqueOrThrow({ where: { id: a.userId } });
        await grantMerchant(tx, user);
      }
    }, TX.default);
    await this.mail(a, 'your seller account is active again',
      `Hi ${a.fullName}, ${a.companyName ?? 'your seller account'} is active again on ${this.storeName}. ` +
        `You can sign in to the Seller Portal: ${this.appBaseUrl}/merchant`);
    await this.trail(a, admin, 'supplier.reinstated', 'Supplier reinstated, seller access restored', { before: 'SUSPENDED', after: 'APPROVED' });
    return this.get(id);
  }

  /**
   * The applicant's account: linked, or found by email, or created (random
   * password; the caller emails a set-password link once committed).
   */
  private async ensureUser(a: SellerApplication, role: 'ROLE_CUSTOMER' | 'ROLE_MERCHANT'): Promise<{ user: User; created: boolean }> {
    if (a.userId) {
      const user = await this.prisma.user.findUnique({ where: { id: a.userId } });
      if (user && !user.deleted) return { user, created: false };
    }
    const existing = await this.prisma.user.findFirst({ where: { email: { equals: a.email.trim(), mode: 'insensitive' }, deleted: false } });
    if (existing) {
      const other = await this.prisma.sellerApplication.findUnique({ where: { userId: existing.id }, select: { id: true, reference: true } });
      if (other && other.id !== a.id) throw conflict(`The account ${existing.email} already has its own application (${other.reference})`);
      await this.prisma.sellerApplication.update({ where: { id: a.id }, data: { userId: existing.id } });
      return { user: existing, created: false };
    }
    try {
      const user = await this.prisma.user.create({
        data: {
          email: a.email.trim().toLowerCase(),
          password: await hashPassword(randomBytes(24).toString('base64url')),
          fullName: a.fullName,
          role,
        },
      });
      await this.prisma.sellerApplication.update({ where: { id: a.id }, data: { userId: user.id } });
      log.info(`Created the account for seller application ${a.reference}`);
      return { user, created: true };
    } catch (e) {
      if (isIntegrityViolation(e)) throw conflict('An account for this email was created meanwhile. Try again.');
      throw e;
    }
  }

  /** Audit-log entry for an admin action on a supplier; written after the change commits, never throws. */
  private async trail(
    a: SellerApplication,
    admin: string | null,
    action: string,
    summary: string,
    extra: Partial<Pick<AuditInput, 'before' | 'after' | 'note' | 'details'>> & { doc?: { id: string; type: string; fileName: string } } = {},
  ) {
    const { doc, ...rest } = extra;
    await this.audit?.record({
      action,
      category: doc ? 'doc' : 'supplier',
      actor: admin ? { email: admin, type: 'team' } : null,
      source: 'Supplier approvals',
      entity: doc
        ? { type: 'document', id: doc.id, code: a.reference, label: `${documentLabel(doc.type)} · ${doc.fileName}` }
        : { type: 'supplier', id: a.id, code: a.reference, label: a.companyName ?? a.fullName },
      seller: a.userId ? { id: a.userId, name: a.companyName ?? a.fullName } : { name: a.companyName ?? a.fullName },
      summary,
      ...rest,
    });
  }

  private async mail(a: SellerApplication, subject: string, body: string) {
    await this.mailer.send({
      template: 'SELLER_APPLICATION',
      to: a.email,
      userId: a.userId,
      subject: `${this.storeName}: ${subject}`,
      body,
    });
  }
}

/** Customers become sellers; staff accounts keep their role (they can already reach the seller tools they need). */
async function grantMerchant(tx: Prisma.TransactionClient, user: User) {
  if (user.role === 'ROLE_CUSTOMER') await tx.user.update({ where: { id: user.id }, data: { role: 'ROLE_MERCHANT' } });
}

function parseDocumentType(raw: unknown): DocumentType {
  const v = typeof raw === 'string' ? raw.trim().toUpperCase().replace(/[-\s]/g, '') : '';
  const found = DOCUMENT_TYPES.find((d) => d.type === v);
  if (!found) throw new ValidationError({ type: `must be one of ${DOCUMENT_TYPES.map((d) => d.type).join(', ')}` });
  return found.type;
}

/** Multer hands the name over as latin1; keep the base name only. */
function cleanFileName(name: string): string {
  const utf8 = Buffer.from(name, 'latin1').toString('utf8');
  const base = utf8.split(/[\\/]/).pop()!.replace(/[\u0000-\u001f"]/g, '').trim();
  return (base || 'document').slice(-255);
}

function stripUndefined<T extends object>(o: T): Partial<T> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>;
}
