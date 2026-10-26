import type { Prisma, PrismaClient, SellerApplication, SupportMessage } from '@prisma/client';
import { z } from 'zod';
import {
  SELLER_APPLICATION_STATUSES,
  SUPPORT_MESSAGE_STATUSES,
  type SellerApplicationStatus,
  type SupportMessageStatus,
} from '../common/enums';
import { DomainError } from '../common/errors';
import { orderBy, skipTake, toPage, type Pageable } from '../common/pagination';
import { oneOf, optionalString } from '../common/validation';

export const INBOX_SORTS = ['createdAt', 'updatedAt', 'status'] as const;

export interface InboxFilter<S extends string> {
  status?: S;
  search?: string;
}

/** `{ status?, adminNote? }`: at least one; a blank note clears it. */
const updateSchema = <S extends string>(statuses: readonly S[]) =>
  z
    .object({
      status: oneOf(statuses),
      adminNote: optionalString({ max: 2000, sizeMessage: 'Note must not exceed 2000 characters' }),
    })
    .refine((v) => v.status !== undefined || v.adminNote !== undefined, {
      message: 'must not be null',
      path: ['status'],
    });

export const SupportMessageUpdateSchema = updateSchema(SUPPORT_MESSAGE_STATUSES);
export const SellerApplicationUpdateSchema = updateSchema(SELLER_APPLICATION_STATUSES);
type Update<S extends string> = { status?: S; adminNote?: string };

/** The queue states the catalog team still has to act on (the review queue's default filter). */
const SUBMISSIONS_AWAITING_REVIEW = ['SUBMITTED', 'IN_REVIEW'];

/**
 * Admin inbox (contract D1): help-center messages and "Sell with us"
 * applications, worked through by status with a private note. Every change
 * records who made it (`handledBy` = the admin's email) and when.
 */
export class AdminInboxService {
  constructor(private readonly prisma: PrismaClient) {}

  async counts() {
    const [supportOpen, sellerApplicationsNew, reviewsPending, submissionsOpen] = await Promise.all([
      this.prisma.supportMessage.count({ where: { status: 'OPEN' } }),
      this.prisma.sellerApplication.count({ where: { status: 'NEW' } }),
      this.prisma.productReview.count({ where: { status: 'PENDING', deleted: false } }),
      this.prisma.productSubmission.count({ where: { status: { in: SUBMISSIONS_AWAITING_REVIEW } } }),
    ]);
    return { supportOpen, sellerApplicationsNew, reviewsPending, submissionsOpen };
  }

  // ── Support messages ──────────────────────────────────────────────────────

  async listMessages(filter: InboxFilter<SupportMessageStatus>, pageable: Pageable) {
    const where: Prisma.SupportMessageWhereInput = {
      ...(filter.status && { status: filter.status }),
      ...(filter.search && {
        OR: (['name', 'email', 'ticketNumber', 'orderNumber'] as const).map((f) => ({
          [f]: { contains: filter.search, mode: 'insensitive' as const },
        })),
      }),
    };
    const [rows, total] = await Promise.all([
      this.prisma.supportMessage.findMany({ where, orderBy: orderBy(pageable, []).concat({ id: 'asc' }), ...skipTake(pageable) }),
      this.prisma.supportMessage.count({ where }),
    ]);
    return toPage(rows.map(toMessage), total, pageable);
  }

  async getMessage(id: string) {
    const row = await this.prisma.supportMessage.findUnique({ where: { id } });
    if (!row) throw notFound('Support message', id);
    return this.withOrder(row);
  }

  async updateMessage(id: string, input: Update<SupportMessageStatus>, adminEmail: string) {
    const exists = await this.prisma.supportMessage.findUnique({ where: { id }, select: { id: true } });
    if (!exists) throw notFound('Support message', id);
    const row = await this.prisma.supportMessage.update({ where: { id }, data: changes(input, adminEmail) });
    return this.withOrder(row);
  }

  /** Detail view: the order the customer quoted, when it exists, so the admin can open it. */
  private async withOrder(row: SupportMessage) {
    const order = row.orderNumber
      ? await this.prisma.order.findFirst({ where: { orderNumber: row.orderNumber, deleted: false }, select: { id: true } })
      : null;
    return { ...toMessage(row), orderId: order?.id ?? null };
  }

  // ── Seller applications ───────────────────────────────────────────────────

  async listApplications(filter: InboxFilter<SellerApplicationStatus>, pageable: Pageable) {
    const where: Prisma.SellerApplicationWhereInput = {
      ...(filter.status && { status: filter.status }),
      ...(filter.search && {
        OR: (['fullName', 'email', 'reference', 'phone', 'city'] as const).map((f) => ({
          [f]: { contains: filter.search, mode: 'insensitive' as const },
        })),
      }),
    };
    const [rows, total] = await Promise.all([
      this.prisma.sellerApplication.findMany({ where, orderBy: orderBy(pageable, []).concat({ id: 'asc' }), ...skipTake(pageable) }),
      this.prisma.sellerApplication.count({ where }),
    ]);
    return toPage(rows.map(toApplication), total, pageable);
  }

  async getApplication(id: string) {
    const row = await this.prisma.sellerApplication.findUnique({ where: { id } });
    if (!row) throw notFound('Seller application', id);
    return toApplication(row);
  }

  async updateApplication(id: string, input: Update<SellerApplicationStatus>, adminEmail: string) {
    const exists = await this.prisma.sellerApplication.findUnique({ where: { id }, select: { id: true } });
    if (!exists) throw notFound('Seller application', id);
    return toApplication(await this.prisma.sellerApplication.update({ where: { id }, data: changes(input, adminEmail) }));
  }
}

const notFound = (what: string, id: string) => new DomainError(404, `${what} ${id} was not found`);

function changes(input: Update<string>, adminEmail: string) {
  return {
    ...(input.status !== undefined && { status: input.status }),
    ...(input.adminNote !== undefined && { adminNote: input.adminNote.trim() || null }),
    handledBy: adminEmail,
    updatedAt: new Date(),
  };
}

const toMessage = (m: SupportMessage) => ({
  id: m.id,
  ticketNumber: m.ticketNumber,
  createdAt: m.createdAt,
  updatedAt: m.updatedAt,
  status: m.status,
  adminNote: m.adminNote,
  handledBy: m.handledBy,
  name: m.name,
  email: m.email,
  topic: m.topic,
  orderNumber: m.orderNumber,
  message: m.message,
});

const toApplication = (a: SellerApplication) => ({
  id: a.id,
  reference: a.reference,
  createdAt: a.createdAt,
  updatedAt: a.updatedAt,
  status: a.status,
  adminNote: a.adminNote,
  handledBy: a.handledBy,
  fullName: a.fullName,
  email: a.email,
  phone: a.phone,
  categories: a.categories,
  products: a.products,
  street: a.street,
  city: a.city,
  state: a.state,
  postalCode: a.postalCode,
  consentAt: a.consentAt,
});
