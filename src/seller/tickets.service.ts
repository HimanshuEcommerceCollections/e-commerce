import type { Prisma, PrismaClient } from '@prisma/client';
import { z } from 'zod';
import { DomainError } from '../common/errors';
import { toPage, type Pageable } from '../common/pagination';
import { flag, oneOf, optionalString, requiredString, ValidationError } from '../common/validation';
import type { Config } from '../config';
import type { Mailer } from '../notify/mailer';

/** designs/seller/seller-support.html */
export const TICKET_TOPICS = ['products', 'orders', 'payments', 'account', 'other'] as const;
export type TicketTopic = (typeof TICKET_TOPICS)[number];
export const TICKET_TABS = ['open', 'waiting', 'resolved', 'all'] as const;
export type TicketTab = (typeof TICKET_TABS)[number];

const TOPIC_LABEL: Record<TicketTopic, string> = {
  products: 'Products & listings',
  orders: 'Orders & shipping',
  payments: 'Payments & payouts',
  account: 'Account & documents',
  other: 'Something else',
};
/** Which team picks a ticket up, by topic. */
const TEAM: Record<TicketTopic, string> = {
  products: 'Catalog team',
  orders: 'Seller support',
  payments: 'Payments',
  account: 'Supplier partnerships',
  other: 'Seller support',
};

const STATUS_FOR_TAB: Record<TicketTab, Prisma.SellerTicketWhereInput> = {
  open: { status: { in: ['OPEN', 'WAITING'] } },
  waiting: { status: 'WAITING' },
  resolved: { status: 'RESOLVED' },
  all: {},
};

export const MAX_ATTACHMENTS = 5;
export const MAX_ATTACHMENT_BYTES = 4 * 1024 * 1024;
/** Screenshots, PDFs and spreadsheets, by extension. */
const ATTACHMENT_TYPES: Record<string, string> = {
  pdf: 'application/pdf',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  csv: 'text/csv',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
};

export const TicketCreateSchema = z.object({
  topic: oneOf(TICKET_TOPICS).refine((v) => v !== undefined, 'choose what it is about'),
  subject: requiredString({ max: 120, blankMessage: 'add a subject' }),
  body: requiredString({ max: 5000, blankMessage: 'tell us what happened' }),
  urgent: flag(),
  relatedType: oneOf(['order', 'product', 'payout'] as const),
  relatedRef: optionalString({ max: 80 }),
});
export const TicketReplySchema = z.object({ body: optionalString({ max: 5000 }), resolve: flag() });

export interface UploadedAttachment {
  originalname: string;
  mimetype?: string;
  size?: number;
  buffer: Buffer;
}

interface Person {
  id: string;
  email: string;
  name: string;
}

const MESSAGES = { orderBy: { createdAt: 'asc' as const }, include: { attachments: { select: { id: true, fileName: true, contentType: true, sizeBytes: true } } } };
const SUMMARY_INCLUDE = {
  assignee: { select: { fullName: true, email: true } },
  messages: { orderBy: { createdAt: 'desc' as const }, take: 1, select: { authorRole: true, authorName: true, createdAt: true } },
  _count: { select: { messages: true } },
} satisfies Prisma.SellerTicketInclude;
type SummaryRow = Prisma.SellerTicketGetPayload<{ include: typeof SUMMARY_INCLUDE }>;
const DETAIL_INCLUDE = { messages: MESSAGES, assignee: { select: { fullName: true, email: true } }, _count: { select: { messages: true } } } satisfies Prisma.SellerTicketInclude;
type Ticket = Prisma.SellerTicketGetPayload<{ include: typeof DETAIL_INCLUDE }>;

/**
 * Seller Help & support: tickets about a product, order, payout or account,
 * routed to a team by topic, with a reply thread on both sides. A staff reply
 * puts the ticket in "Waiting for you" and emails the seller; a seller reply
 * puts it back with our team.
 */
export class SellerTicketService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly mailer: Mailer,
    private readonly config: Config,
  ) {}

  // ── Seller side ───────────────────────────────────────────────────────────

  async list(seller: Person, tab: TicketTab) {
    const base = { merchantId: seller.id };
    const [rows, counts] = await Promise.all([
      this.prisma.sellerTicket.findMany({ where: { ...base, ...STATUS_FOR_TAB[tab] }, include: SUMMARY_INCLUDE, orderBy: { lastMessageAt: 'desc' }, take: 200 }),
      this.counts(base),
    ]);
    return { content: rows.map((t) => this.summary(t, t.messages[0])), counts };
  }

  async create(seller: Person, input: z.output<typeof TicketCreateSchema>, files: UploadedAttachment[]) {
    const topic = input.topic as TicketTopic;
    const related = await this.related(seller.id, input.relatedType, input.relatedRef);
    const attachments = checkAttachments(files);
    const now = new Date();
    const ticket = await this.prisma.$transaction(async (tx) => {
      const reference = await nextReference(tx);
      return tx.sellerTicket.create({
        data: {
          reference,
          merchantId: seller.id,
          topic,
          subject: input.subject.trim(),
          relatedType: related?.type ?? null,
          relatedRef: related?.ref ?? null,
          urgent: input.urgent,
          status: 'OPEN',
          team: TEAM[topic],
          lastMessageAt: now,
          messages: {
            create: { authorId: seller.id, authorRole: 'SELLER', authorName: seller.name, body: input.body.trim(), attachments: { create: attachments } },
          },
        },
      });
    });
    return this.get(seller, ticket.reference);
  }

  async get(seller: Person, reference: string) {
    return this.detail(await this.find({ reference, merchantId: seller.id }));
  }

  async reply(seller: Person, reference: string, body: string | undefined, files: UploadedAttachment[]) {
    const t = await this.find({ reference, merchantId: seller.id });
    if (t.status === 'RESOLVED') throw new DomainError(409, 'This ticket is resolved; reopen it to reply');
    await this.addMessage(t.id, { authorId: seller.id, authorRole: 'SELLER', authorName: seller.name }, body, files, 'OPEN');
    return this.get(seller, reference);
  }

  async resolve(seller: Person, reference: string) {
    const t = await this.find({ reference, merchantId: seller.id });
    if (t.status !== 'RESOLVED') await this.prisma.sellerTicket.update({ where: { id: t.id }, data: { status: 'RESOLVED', resolvedAt: new Date() } });
    return this.get(seller, reference);
  }

  async reopen(seller: Person, reference: string) {
    const t = await this.find({ reference, merchantId: seller.id });
    if (t.status !== 'RESOLVED') throw new DomainError(409, 'This ticket is already open');
    await this.addMessage(t.id, { authorId: seller.id, authorRole: 'SELLER', authorName: seller.name }, 'Reopened: this is still a problem.', [], 'OPEN');
    await this.prisma.sellerTicket.update({ where: { id: t.id }, data: { resolvedAt: null } });
    return this.get(seller, reference);
  }

  /** An attachment of one of the seller's tickets (or any ticket, for staff: pass merchantId undefined). */
  async attachment(reference: string, attachmentId: string, merchantId?: string) {
    const a = await this.prisma.sellerTicketAttachment.findFirst({
      where: { id: attachmentId, message: { ticket: { reference, ...(merchantId ? { merchantId } : {}) } } },
    });
    if (!a) throw new DomainError(404, 'Attachment not found');
    return a;
  }

  /** Tickets waiting for the seller's answer (for the dashboard and the nav badge). */
  async waitingCount(sellerId: string) {
    return this.prisma.sellerTicket.count({ where: { merchantId: sellerId, status: 'WAITING' } });
  }

  // ── Staff side ────────────────────────────────────────────────────────────

  async adminList(filter: { tab: TicketTab; q?: string; mine?: boolean }, staffId: string, pageable: Pageable) {
    const q = filter.q?.trim();
    // "open" for staff = with our team; "waiting" = waiting for the seller.
    const status: Prisma.SellerTicketWhereInput =
      filter.tab === 'open' ? { status: 'OPEN' } : filter.tab === 'all' ? {} : STATUS_FOR_TAB[filter.tab];
    const where: Prisma.SellerTicketWhereInput = {
      ...status,
      ...(filter.mine ? { assigneeId: staffId } : {}),
      ...(q
        ? {
            OR: [
              { reference: { contains: q, mode: 'insensitive' } },
              { subject: { contains: q, mode: 'insensitive' } },
              { merchant: { email: { contains: q, mode: 'insensitive' } } },
              { merchant: { fullName: { contains: q, mode: 'insensitive' } } },
            ],
          }
        : {}),
    };
    const [rows, total, open, waiting, resolved, urgent] = await Promise.all([
      this.prisma.sellerTicket.findMany({
        where,
        include: { ...SUMMARY_INCLUDE, merchant: { select: { fullName: true, email: true, sellerApplication: { select: { companyName: true } } } } },
        // Urgent first, then the longest waiting.
        orderBy: filter.tab === 'open' ? [{ urgent: 'desc' }, { lastMessageAt: 'asc' }] : [{ lastMessageAt: 'desc' }],
        skip: pageable.page * pageable.size,
        take: pageable.size,
      }),
      this.prisma.sellerTicket.count({ where }),
      this.prisma.sellerTicket.count({ where: { status: 'OPEN' } }),
      this.prisma.sellerTicket.count({ where: { status: 'WAITING' } }),
      this.prisma.sellerTicket.count({ where: { status: 'RESOLVED' } }),
      this.prisma.sellerTicket.count({ where: { status: 'OPEN', urgent: true } }),
    ]);
    return {
      ...toPage(
        rows.map((t) => ({ ...this.summary(t, t.messages[0]), seller: sellerOf(t.merchant) })),
        total,
        pageable,
      ),
      counts: { open, waiting, resolved, urgent },
    };
  }

  async adminGet(reference: string) {
    const t = await this.find({ reference });
    const merchant = await this.prisma.user.findUniqueOrThrow({
      where: { id: t.merchantId },
      select: { fullName: true, email: true, sellerApplication: { select: { companyName: true } } },
    });
    return { ...this.detail(t), seller: sellerOf(merchant) };
  }

  async staffReply(staff: Person, reference: string, input: z.output<typeof TicketReplySchema>, files: UploadedAttachment[]) {
    const t = await this.find({ reference });
    const body = input.body?.trim();
    if (body || files.length) {
      await this.addMessage(t.id, { authorId: staff.id, authorRole: 'STAFF', authorName: staff.name }, body, files, input.resolve ? 'RESOLVED' : 'WAITING');
    } else if (!input.resolve) {
      throw new ValidationError({ body: 'write your reply first' });
    }
    await this.prisma.sellerTicket.update({
      where: { id: t.id },
      data: {
        ...(t.assigneeId ? {} : { assigneeId: staff.id }),
        ...(input.resolve ? { status: 'RESOLVED', resolvedAt: new Date() } : {}),
      },
    });
    const merchant = await this.prisma.user.findUnique({ where: { id: t.merchantId }, select: { email: true } });
    if (merchant && (body || input.resolve)) {
      await this.mailer.send({
        template: 'SUPPORT_TICKET',
        to: merchant.email,
        subject: input.resolve ? `${t.reference} resolved: ${t.subject}` : `New reply on ${t.reference}: ${t.subject}`,
        body: [
          input.resolve ? `${staff.name} marked your ticket ${t.reference} as resolved.` : `${staff.name} (${t.team}) replied to your ticket ${t.reference}:`,
          ...(body ? ['', body] : []),
          '',
          `Reply in the Seller Portal: ${this.config.store.appBaseUrl}/merchant/support/${t.reference}`,
          '',
          this.config.store.name,
        ].join('\n'),
        userId: t.merchantId,
      });
    }
    return this.adminGet(reference);
  }

  async assign(staff: Person, reference: string) {
    const t = await this.find({ reference });
    await this.prisma.sellerTicket.update({ where: { id: t.id }, data: { assigneeId: staff.id } });
    return this.adminGet(reference);
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  private async counts(base: Prisma.SellerTicketWhereInput) {
    const [open, waiting, resolved, all] = await Promise.all(
      (['open', 'waiting', 'resolved', 'all'] as const).map((t) => this.prisma.sellerTicket.count({ where: { ...base, ...STATUS_FOR_TAB[t] } })),
    );
    return { open, waiting, resolved, all };
  }

  private async find(where: Prisma.SellerTicketWhereInput) {
    const t = await this.prisma.sellerTicket.findFirst({ where, include: DETAIL_INCLUDE });
    if (!t) throw new DomainError(404, 'Ticket not found');
    return t;
  }

  private async addMessage(
    ticketId: string,
    author: { authorId: string; authorRole: 'SELLER' | 'STAFF'; authorName: string },
    body: string | undefined,
    files: UploadedAttachment[],
    status: 'OPEN' | 'WAITING' | 'RESOLVED',
  ) {
    const text = body?.trim() ?? '';
    if (!text && !files.length) throw new ValidationError({ body: 'write your reply first' });
    const attachments = checkAttachments(files);
    const now = new Date();
    await this.prisma.$transaction([
      this.prisma.sellerTicketMessage.create({ data: { ticketId, ...author, body: text, attachments: { create: attachments } } }),
      this.prisma.sellerTicket.update({ where: { id: ticketId }, data: { status, lastMessageAt: now } }),
    ]);
  }

  /** The order, product or payout a ticket is about; it must be the seller's. */
  private async related(merchantId: string, type: 'order' | 'product' | 'payout' | undefined, ref: string | undefined) {
    if (!type || !ref) return null;
    const found =
      type === 'order'
        ? await this.prisma.order.count({ where: { orderNumber: ref, items: { some: { merchantId } } } })
        : type === 'product'
          ? await this.prisma.parentProduct.count({ where: { id: /^[0-9a-f-]{36}$/i.test(ref) ? ref : undefined, merchantId } })
          : await this.prisma.sellerPayout.count({ where: { reference: ref, merchantId } });
    if (!found) throw new ValidationError({ relatedRef: `that ${type} wasn't found in your account` });
    return { type, ref };
  }

  /** `last` is the newest message (lists load only that one; a ticket's detail loads them all). */
  private summary(t: SummaryRow | Ticket, last: { authorRole: string; authorName: string } | undefined) {
    return {
      reference: t.reference,
      subject: t.subject,
      topic: t.topic,
      topicLabel: TOPIC_LABEL[t.topic as TicketTopic] ?? t.topic,
      status: t.status,
      urgent: t.urgent,
      team: t.team,
      assignee: t.assignee ? t.assignee.fullName || t.assignee.email : null,
      related: t.relatedType && t.relatedRef ? { type: t.relatedType, ref: t.relatedRef } : null,
      createdAt: t.createdAt,
      lastMessageAt: t.lastMessageAt,
      lastMessage: last ? { role: last.authorRole, name: last.authorName } : null,
      resolvedAt: t.resolvedAt,
      messageCount: t._count.messages,
    };
  }

  private detail(t: Ticket) {
    return {
      ...this.summary(t, t.messages[t.messages.length - 1]),
      messages: t.messages.map((m) => ({
        id: m.id,
        role: m.authorRole,
        name: m.authorName,
        body: m.body,
        createdAt: m.createdAt,
        attachments: m.attachments,
      })),
    };
  }
}

const sellerOf = (m: { fullName: string | null; email: string; sellerApplication: { companyName: string | null } | null }) => ({
  name: m.fullName || m.email,
  email: m.email,
  company: m.sellerApplication?.companyName ?? null,
});

function checkAttachments(files: UploadedAttachment[]) {
  if (files.length > MAX_ATTACHMENTS) throw new ValidationError({ files: `attach at most ${MAX_ATTACHMENTS} files` });
  return files.map((f) => {
    const ext = f.originalname.split('.').pop()?.toLowerCase() ?? '';
    const contentType = ATTACHMENT_TYPES[ext];
    if (!contentType) throw new ValidationError({ files: `${f.originalname}: attach a PDF, JPG, PNG, WebP, CSV or XLSX file` });
    if (f.buffer.length > MAX_ATTACHMENT_BYTES) throw new DomainError(413, `${f.originalname} is larger than 4 MB`);
    return { fileName: f.originalname.slice(0, 255), contentType, sizeBytes: f.buffer.length, content: new Uint8Array(f.buffer) };
  });
}

async function nextReference(tx: Prisma.TransactionClient) {
  // Serialises reference numbers across concurrent creates.
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('seller_tickets_reference'))`;
  const last = await tx.sellerTicket.findFirst({ orderBy: { createdAt: 'desc' }, select: { reference: true } });
  const n = last ? Number(last.reference.replace(/\D/g, '')) || 3100 : 3100;
  return `T-${n + 1}`;
}
