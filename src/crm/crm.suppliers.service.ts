import { Prisma, type PrismaClient, type SellerApplication } from '@prisma/client';
import { z } from 'zod';
import { DomainError } from '../common/errors';
import { integer, oneOf, optionalString, requiredString } from '../common/validation';
import type { Config } from '../config';
import {
  AUTO_STAGES,
  DAY,
  LOST_REASONS,
  PIPELINE_STAGES,
  STAGE_KEYS,
  STAGE_LABEL,
  SUPPLIER_SOURCES,
  isOpenStage,
  isUniqueViolation,
  logActivity,
  memberOf,
  nullableUuid,
  ticketRef,
  type PipelineStage,
  type Staff,
  type Team,
} from './crm.shared';

const emailField = () => z.preprocess((v) => (v === '' ? undefined : v), optionalString({ max: 255, email: true, emailMessage: 'Check the email' }));

export const SupplierCreateSchema = z.object({
  company: requiredString({ max: 200, blankMessage: 'Enter the company name', min: 2, sizeMessage: 'Enter the company name' }),
  contactName: optionalString({ max: 200 }),
  email: emailField(),
  category: optionalString({ max: 120 }),
  source: oneOf(SUPPLIER_SOURCES),
  estProducts: integer({ positiveOrZero: true, max: 1_000_000 }),
  ownerId: nullableUuid,
});

export const SupplierUpdateSchema = z.object({
  ownerId: nullableUuid,
  nextStep: optionalString({ max: 300 }),
  /** ISO date or timestamp; null clears it. */
  nextDue: z.union([z.string().datetime({ offset: true }), z.string().regex(/^\d{4}-\d{2}-\d{2}$/), z.null()]).optional(),
});

export const StageMoveSchema = z.object({
  stage: oneOf(STAGE_KEYS).refine((v) => v !== undefined, 'Choose a stage'),
  /** Why a supplier is lost; one of LOST_REASONS. */
  reason: oneOf(LOST_REASONS),
  note: optionalString({ max: 300 }),
});

/** The application's stage as a pipeline stage; a legacy "Sell with us" lead follows its inbox status. */
export function pipelineStageOf(a: Pick<SellerApplication, 'userId' | 'stage' | 'status' | 'declineReason' | 'suspensionReason'>): {
  stage: PipelineStage;
  lostReason: string | null;
} {
  if (!a.userId) {
    const byStatus: Record<string, PipelineStage> = { NEW: 'lead', CONTACTED: 'contacted', APPROVED: 'interested', REJECTED: 'lost' };
    const stage = byStatus[a.status] ?? 'lead';
    return { stage, lostReason: stage === 'lost' ? 'Rejected in the applications inbox' : null };
  }
  switch (a.stage) {
    case 'SCORECARD':
      return { stage: 'review', lostReason: null };
    case 'DOCUMENTS':
      return { stage: 'documents', lostReason: null };
    case 'APPROVED':
      return { stage: 'live', lostReason: null };
    case 'DECLINED':
      return { stage: 'lost', lostReason: a.declineReason?.slice(0, 500) || 'Declined after review' };
    case 'AUTO_REJECTED':
      return { stage: 'lost', lostReason: 'Failed scorecard' };
    case 'SUSPENDED':
      return { stage: 'lost', lostReason: `Suspended${a.suspensionReason ? `: ${a.suspensionReason}` : ''}`.slice(0, 500) };
    default: // DRAFT, APPLIED, SCREENED
      return { stage: 'applied', lostReason: null };
  }
}

/** "Under 50", "50–200", "200–1,000", "Over 1,000" (or a plain number) → a number to plan around. */
export function estimateProducts(text: string | null | undefined): number {
  const t = (text ?? '').toLowerCase();
  const nums = (t.match(/\d[\d,]*/g) ?? []).map((n) => Number(n.replace(/,/g, '')));
  if (!nums.length) return 0;
  if (t.startsWith('under')) return Math.round(nums[0]! / 2);
  if (t.startsWith('over') || t.startsWith('more')) return Math.round(nums[0]! * 1.5);
  return nums.length > 1 ? Math.round((nums[0]! + nums[1]!) / 2) : nums[0]!;
}

const signature = (a: { stage: string; status: string }) => `${a.stage}:${a.status}`;

/**
 * Suppliers: the sales pipeline from first contact to live. Application
 * stages (applied, in review, documents, live) follow the Seller Portal; the
 * early stages and "lost" are moved by hand.
 */
export class CrmSupplierService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly team: Team,
    private readonly config: Config,
  ) {}

  // ── Sync with seller applications ─────────────────────────────────────────

  /**
   * Adds a card for every application that has none, and moves the card of an
   * application whose stage changed since it was last copied. A card moved by
   * hand stays where it was put until the application moves again.
   */
  async syncApplications(): Promise<void> {
    const due = await this.prisma.$queryRaw<{ id: string }[]>`
      SELECT a.id FROM seller_applications a
        LEFT JOIN crm_suppliers s ON s.application_id = a.id
       WHERE s.id IS NULL OR s.app_stage IS DISTINCT FROM (a.stage || ':' || a.status)
       ORDER BY a.created_at LIMIT 500`;
    if (!due.length) return;
    const apps = await this.prisma.sellerApplication.findMany({ where: { id: { in: due.map((d) => d.id) } }, include: { crmSupplier: true } });
    for (const a of apps) {
      try {
        const { stage, lostReason } = pipelineStageOf(a);
        const sig = signature(a);
        const s = a.crmSupplier;
        if (!s) {
          // The merchant may already have a card (a seller who raised a ticket before applying).
          const existing = a.userId ? await this.prisma.crmSupplier.findUnique({ where: { userId: a.userId } }) : null;
          if (existing && !existing.applicationId) {
            await this.prisma.crmSupplier.update({ where: { id: existing.id }, data: { applicationId: a.id, appStage: sig } });
            await this.moveByApplication(existing.id, existing.stage as PipelineStage, stage, lostReason, sig);
            continue;
          }
          const at = a.stageChangedAt ?? a.submittedAt ?? a.createdAt;
          const created = await this.prisma.crmSupplier.create({
            data: {
              company: (a.companyName || a.fullName).slice(0, 200),
              contactName: a.fullName.slice(0, 200),
              email: a.email.slice(0, 255),
              phone: a.phone.slice(0, 30),
              location: [a.city, a.state].filter(Boolean).join(', ').slice(0, 200) || null,
              category: a.categories.join(', ').slice(0, 120) || null,
              stage,
              stageChangedAt: at,
              estProducts: estimateProducts(a.products),
              source: a.userId ? 'Seller Portal' : 'Inbound',
              nextStep: isOpenStage(stage) && !a.userId ? 'First outreach' : null,
              nextDue: isOpenStage(stage) && !a.userId ? new Date(Date.now() + DAY) : null,
              lostReason: stage === 'lost' ? lostReason : null,
              userId: a.userId,
              applicationId: a.id,
              appStage: sig,
              createdAt: a.createdAt,
            },
          });
          await logActivity(this.prisma, { supplierId: created.id }, 'stage', `Added from application ${a.reference} (${STAGE_LABEL[stage]})`, null);
        } else {
          await this.moveByApplication(s.id, s.stage as PipelineStage, stage, lostReason, sig, a.userId);
        }
      } catch (e) {
        if (!isUnique(e)) throw e; // a concurrent sync got there first
      }
    }
  }

  private async moveByApplication(id: string, from: PipelineStage, to: PipelineStage, lostReason: string | null, sig: string, userId?: string | null) {
    const open = isOpenStage(to);
    await this.prisma.crmSupplier.update({
      where: { id },
      data: {
        appStage: sig,
        ...(userId ? { userId } : {}),
        ...(from !== to
          ? {
              stage: to,
              stageChangedAt: new Date(),
              lostReason: to === 'lost' ? lostReason : null,
              ...(open ? {} : { nextStep: null, nextDue: null }),
            }
          : {}),
      },
    });
    if (from !== to) {
      await logActivity(this.prisma, { supplierId: id }, 'stage', to === 'lost' ? `Marked Lost: ${lostReason}` : `Moved from ${STAGE_LABEL[from]} to ${STAGE_LABEL[to]} (Seller Portal)`, null);
    }
  }

  /** The card for a seller's account, made on the spot for a seller who never applied here (demo and seeded accounts). */
  async forMerchant(userId: string): Promise<string> {
    const found = await this.prisma.crmSupplier.findUnique({ where: { userId }, select: { id: true } });
    if (found) return found.id;
    await this.syncApplications();
    const afterSync = await this.prisma.crmSupplier.findUnique({ where: { userId }, select: { id: true } });
    if (afterSync) return afterSync.id;
    const u = await this.prisma.user.findUniqueOrThrow({ where: { id: userId }, select: { fullName: true, email: true, phoneNumber: true } });
    try {
      const created = await this.prisma.crmSupplier.create({
        data: {
          company: u.fullName || u.email,
          contactName: u.fullName || null,
          email: u.email,
          phone: u.phoneNumber,
          stage: 'live',
          stageChangedAt: new Date(),
          source: 'Seller Portal',
          userId,
        },
      });
      await logActivity(this.prisma, { supplierId: created.id }, 'stage', 'Added from the seller account', null);
      return created.id;
    } catch (e) {
      if (!isUnique(e)) throw e;
      return (await this.prisma.crmSupplier.findUniqueOrThrow({ where: { userId }, select: { id: true } })).id;
    }
  }

  // ── Reads ─────────────────────────────────────────────────────────────────

  /** The board and list: every supplier (lost ones on request), with the strip of totals over the whole pipeline. */
  async list(filter: { q?: string; owner?: string; includeLost?: boolean }) {
    const q = filter.q?.trim();
    const where: Prisma.CrmSupplierWhereInput = {
      ...(filter.includeLost ? {} : { stage: { not: 'lost' } }),
      ...(filter.owner ? { ownerId: filter.owner === 'none' ? null : filter.owner } : {}),
      ...(q
        ? {
            OR: [
              { company: { contains: q, mode: 'insensitive' } },
              { contactName: { contains: q, mode: 'insensitive' } },
              { category: { contains: q, mode: 'insensitive' } },
              { email: { contains: q, mode: 'insensitive' } },
            ],
          }
        : {}),
    };
    const [rows, all] = await Promise.all([
      this.prisma.crmSupplier.findMany({ where, orderBy: [{ nextDue: { sort: 'asc', nulls: 'last' } }, { company: 'asc' }], take: 1000 }),
      this.prisma.crmSupplier.findMany({ select: { stage: true, estProducts: true, nextDue: true, stageChangedAt: true } }),
    ]);
    const [team, live] = await Promise.all([this.team.byId(), this.liveCounts(rows.filter((r) => r.userId).map((r) => r.userId!))]);
    const now = Date.now();
    const open = all.filter((s) => isOpenStage(s.stage));
    return {
      content: rows.map((s) => this.row(s, team, live)),
      strip: {
        inProgress: open.length,
        productsOnTheWay: open.reduce((n, s) => n + s.estProducts, 0),
        live: all.filter((s) => s.stage === 'live').length,
        overdueNextSteps: open.filter((s) => s.nextDue && s.nextDue.getTime() < now - DAY / 2).length,
        stuck: open.filter((s) => now - s.stageChangedAt.getTime() > this.config.crm.stuckDays * DAY).length,
        lost: all.filter((s) => s.stage === 'lost').length,
      },
      stages: PIPELINE_STAGES.map(([key, label, description]) => ({ key, label, description, auto: (AUTO_STAGES as readonly string[]).includes(key) })),
    };
  }

  async get(id: string) {
    const s = await this.prisma.crmSupplier.findUnique({ where: { id }, include: { application: { select: { id: true, reference: true, stage: true } } } });
    if (!s) throw new DomainError(404, 'Supplier not found');
    const [team, live, tickets, tasks, activities] = await Promise.all([
      this.team.byId(),
      this.liveCounts(s.userId ? [s.userId] : []),
      this.prisma.crmTicket.findMany({ where: { supplierId: id }, orderBy: { createdAt: 'desc' }, take: 50 }),
      this.prisma.crmTask.findMany({ where: { supplierId: id }, orderBy: [{ doneAt: { sort: 'asc', nulls: 'first' } }, { dueAt: 'asc' }], take: 100 }),
      this.prisma.crmActivity.findMany({ where: { supplierId: id }, orderBy: { createdAt: 'desc' }, take: 200 }),
    ]);
    return {
      ...this.row(s, team, live),
      application: s.application ? { id: s.application.id, reference: s.application.reference, stage: s.application.stage } : null,
      tickets: tickets.map((t) => ({ reference: ticketRef(t.number), subject: t.subject, status: t.status, createdAt: t.createdAt })),
      tasks: tasks.map((k) => ({ id: k.id, title: k.title, dueAt: k.dueAt, done: k.doneAt !== null, owner: memberOf(team, k.ownerId) })),
      history: activities.map((a) => ({ id: a.id, kind: a.kind, body: a.body, by: a.authorName, at: a.createdAt })),
    };
  }

  /** Suppliers sitting in one open stage past the limit. */
  async stuck() {
    const cutoff = new Date(Date.now() - this.config.crm.stuckDays * DAY);
    const rows = await this.prisma.crmSupplier.findMany({
      where: { stage: { notIn: ['live', 'lost'] }, stageChangedAt: { lt: cutoff } },
      orderBy: { stageChangedAt: 'asc' },
      take: 50,
    });
    return rows.map((s) => ({ id: s.id, code: `S-${s.number}`, company: s.company, stage: s.stage, stageChangedAt: s.stageChangedAt }));
  }

  async funnel() {
    const groups = await this.prisma.crmSupplier.groupBy({ by: ['stage'], _count: { _all: true } });
    const n = new Map(groups.map((g) => [g.stage, g._count._all]));
    return PIPELINE_STAGES.filter(([k]) => k !== 'lost').map(([key, label]) => ({ key, label, count: n.get(key) ?? 0 }));
  }

  // ── Writes ────────────────────────────────────────────────────────────────

  async create(input: z.output<typeof SupplierCreateSchema>, staff: Staff) {
    await this.team.assertMember(input.ownerId);
    const now = new Date();
    const s = await this.prisma.crmSupplier.create({
      data: {
        company: input.company.trim(),
        contactName: input.contactName?.trim() || null,
        email: input.email?.trim() || null,
        category: input.category?.trim() || null,
        source: input.source ?? 'Outreach',
        estProducts: input.estProducts ?? 0,
        ownerId: input.ownerId === undefined ? staff.id : input.ownerId,
        stage: 'lead',
        stageChangedAt: now,
        nextStep: 'First outreach',
        nextDue: new Date(now.getTime() + DAY),
      },
    });
    await logActivity(this.prisma, { supplierId: s.id }, 'stage', 'Added as a lead', staff);
    return this.get(s.id);
  }

  async update(id: string, input: z.output<typeof SupplierUpdateSchema>, staff: Staff) {
    const s = await this.prisma.crmSupplier.findUnique({ where: { id } });
    if (!s) throw new DomainError(404, 'Supplier not found');
    if (input.ownerId !== undefined) await this.team.assertMember(input.ownerId);
    const data: Prisma.CrmSupplierUpdateInput = {};
    if (input.ownerId !== undefined) data.ownerId = input.ownerId;
    if (input.nextStep !== undefined) data.nextStep = input.nextStep.trim() || null;
    if (input.nextDue !== undefined) data.nextDue = input.nextDue === null ? null : new Date(input.nextDue.length === 10 ? `${input.nextDue}T12:00:00` : input.nextDue);
    await this.prisma.crmSupplier.update({ where: { id }, data });
    if (input.ownerId !== undefined && input.ownerId !== s.ownerId) {
      const owner = memberOf(await this.team.byId(), input.ownerId);
      await logActivity(this.prisma, { supplierId: id }, 'note', `Owner changed to ${owner?.name ?? 'nobody'}`, staff);
    }
    return this.get(id);
  }

  /** Moves a card to another stage (dragging it, or the stage bar on its profile). */
  async moveStage(id: string, input: z.output<typeof StageMoveSchema>, staff: Staff) {
    const s = await this.prisma.crmSupplier.findUnique({ where: { id } });
    if (!s) throw new DomainError(404, 'Supplier not found');
    const to = input.stage as PipelineStage;
    if (s.stage === to) return this.get(id);
    const reason = input.reason ? (input.note?.trim() ? `${input.reason} – ${input.note.trim()}` : input.reason) : null;
    if (to === 'lost' && !reason) throw new DomainError(400, 'Say why this supplier is lost');
    await this.prisma.crmSupplier.update({
      where: { id },
      data: {
        stage: to,
        stageChangedAt: new Date(),
        lostReason: to === 'lost' ? reason : null,
        ...(isOpenStage(to) ? {} : { nextStep: null, nextDue: null }),
      },
    });
    await logActivity(
      this.prisma,
      { supplierId: id },
      'stage',
      to === 'lost' ? `Marked Lost: ${reason}` : `Moved from ${STAGE_LABEL[s.stage as PipelineStage]} to ${STAGE_LABEL[to]}`,
      staff,
    );
    return this.get(id);
  }

  async emailOf(id: string) {
    const s = await this.prisma.crmSupplier.findUnique({ where: { id }, select: { email: true, contactName: true, company: true, userId: true } });
    if (!s) throw new DomainError(404, 'Supplier not found');
    return { email: s.email, name: s.contactName || s.company, userId: s.userId };
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  /** Live products per merchant account: variants on sale. */
  private async liveCounts(userIds: string[]): Promise<Map<string, number>> {
    if (!userIds.length) return new Map();
    const groups = await this.prisma.product.groupBy({
      by: ['merchantId'],
      where: { merchantId: { in: userIds }, status: 'ACTIVE', deleted: false },
      _count: { _all: true },
    });
    return new Map(groups.map((g) => [g.merchantId, g._count._all]));
  }

  private row(
    s: {
      id: string;
      number: number;
      company: string;
      contactName: string | null;
      email: string | null;
      phone: string | null;
      location: string | null;
      category: string | null;
      stage: string;
      stageChangedAt: Date;
      estProducts: number;
      source: string;
      ownerId: string | null;
      nextStep: string | null;
      nextDue: Date | null;
      lostReason: string | null;
      userId: string | null;
      applicationId: string | null;
      createdAt: Date;
    },
    team: Awaited<ReturnType<Team['byId']>>,
    live: Map<string, number>,
  ) {
    return {
      id: s.id,
      code: `S-${s.number}`,
      company: s.company,
      contact: s.contactName,
      email: s.email,
      phone: s.phone,
      location: s.location,
      category: s.category,
      stage: s.stage as PipelineStage,
      stageChangedAt: s.stageChangedAt,
      estProducts: s.estProducts,
      liveProducts: s.userId ? (live.get(s.userId) ?? 0) : 0,
      source: s.source,
      owner: memberOf(team, s.ownerId),
      nextStep: s.nextStep,
      nextDue: s.nextDue,
      lostReason: s.lostReason,
      /** Stages that follow the Seller Portal on their own. */
      followsPortal: s.applicationId !== null && (AUTO_STAGES as readonly string[]).includes(s.stage),
      since: s.createdAt,
    };
  }
}

const isUnique = isUniqueViolation;
