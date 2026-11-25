import type { PrismaClient } from '@prisma/client';
import type { Config } from '../config';
import { logger } from '../common/logger';
import type { CrmCustomerService } from './crm.customers.service';
import type { CrmSupplierService } from './crm.suppliers.service';
import {
  isUniqueViolation,
  logActivity,
  slaDue,
  ticketRef,
  type Team,
  type TicketCategory,
  type TicketPriority,
  type TicketStatus,
} from './crm.shared';

const log = logger('crm');

const BATCH = 200;

const SELLER_STATUS: Record<string, TicketStatus> = { OPEN: 'open', WAITING: 'pending', RESOLVED: 'solved' };
const SELLER_TOPIC: Record<string, TicketCategory> = {
  products: 'Listing issue',
  orders: 'Order',
  payments: 'Payouts',
  account: 'Documents',
  other: 'Other',
};
/** The help center's topic menu → the CRM's ticket types. */
const HELP_TOPIC: Record<string, TicketCategory> = {
  'where is my order?': 'Delivery',
  'returns and refunds': 'Return / refund',
  'damaged or wrong item': 'Return / refund',
  'payment or billing': 'Order',
  'product question': 'Product question',
  account: 'Account',
  'something else': 'Other',
};
const SUPPORT_STATUS: Record<string, TicketStatus> = { OPEN: 'open', IN_PROGRESS: 'open', CLOSED: 'solved' };

/**
 * Tickets raised elsewhere arrive in the CRM by themselves: help-center
 * messages from shoppers, Seller Portal tickets from suppliers, and seller
 * applications as pipeline cards. The copy runs when someone opens the CRM (at
 * most every `crm.syncIntervalMs`), so nothing in the shop or the Seller Portal
 * needs to know the CRM exists. Each source row is copied once (its id is the
 * ticket's `sourceRef`, unique), then followed: a seller's new message or a
 * status change on their side shows up here on the next copy.
 */
export class CrmIngestService {
  private last = 0;
  private running: Promise<void> | null = null;

  constructor(
    private readonly prisma: PrismaClient,
    private readonly config: Config,
    private readonly team: Team,
    private readonly customers: CrmCustomerService,
    private readonly suppliers: CrmSupplierService,
  ) {}

  /** Brings the CRM up to date with its sources; concurrent callers share one run. */
  sync(force = false): Promise<void> {
    if (this.running) return this.running;
    if (!force && Date.now() - this.last < this.config.crm.syncIntervalMs) return Promise.resolve();
    this.running = this.run()
      .catch((e) => log.warn('CRM sync failed', e))
      .finally(() => {
        this.last = Date.now();
        this.running = null;
      });
    return this.running;
  }

  private async run() {
    await this.customers.ensureAccounts();
    await this.suppliers.syncApplications();
    await this.helpCenter();
    await this.sellerTickets();
  }

  // ── Help center ───────────────────────────────────────────────────────────

  private async helpCenter() {
    const due = await this.prisma.$queryRaw<{ id: string }[]>`
      SELECT m.id FROM support_messages m
       WHERE NOT EXISTS (SELECT 1 FROM crm_tickets t WHERE t.source = 'HELP_CENTER' AND t.source_ref = m.id::text)
       ORDER BY m.created_at LIMIT ${BATCH}`;
    if (!due.length) return;
    const rows = await this.prisma.supportMessage.findMany({ where: { id: { in: due.map((d) => d.id) } }, orderBy: { createdAt: 'asc' } });
    for (const m of rows) {
      try {
        const email = m.email.trim();
        const account = await this.prisma.user.findFirst({
          where: { email: { equals: email, mode: 'insensitive' }, role: 'ROLE_CUSTOMER', deleted: false },
          select: { id: true },
        });
        const customer = account
          ? await this.prisma.crmCustomer.findUnique({ where: { userId: account.id }, select: { id: true } })
          : await this.prisma.crmCustomer.findFirst({ where: { email: { equals: email, mode: 'insensitive' } }, select: { id: true } });
        const status = SUPPORT_STATUS[m.status] ?? 'open';
        const priority: TicketPriority = 'normal';
        const subject = `${m.topic}${m.orderNumber ? ` · order ${m.orderNumber}` : ''}`.slice(0, 200);
        const t = await this.prisma.crmTicket.create({
          data: {
            subject,
            category: HELP_TOPIC[m.topic.toLowerCase()] ?? 'Other',
            priority,
            status,
            channel: 'Help center',
            requesterKind: 'customer',
            customerId: customer?.id ?? null,
            requesterName: m.name.slice(0, 200),
            requesterEmail: email.slice(0, 255),
            slaDueAt: slaDue(m.createdAt, priority),
            lastMessageAt: m.createdAt,
            solvedAt: status === 'solved' ? (m.updatedAt ?? m.createdAt) : null,
            source: 'HELP_CENTER',
            sourceRef: m.id,
            externalRef: m.ticketNumber,
            createdAt: m.createdAt,
            messages: { create: { kind: 'requester', authorName: m.name.slice(0, 200), body: m.message.slice(0, 5000), createdAt: m.createdAt } },
          },
        });
        if (customer) await logActivity(this.prisma, { customerId: customer.id }, 'ticket', `Opened ticket ${ticketRef(t.number)}: ${subject}`, null, m.createdAt);
      } catch (e) {
        if (!isUniqueViolation(e)) throw e; // another instance copied it first
      }
    }
  }

  // ── Seller Portal tickets ─────────────────────────────────────────────────

  private async sellerTickets() {
    const due = await this.prisma.$queryRaw<{ id: string }[]>`
      SELECT s.id FROM seller_tickets s
        LEFT JOIN crm_tickets t ON t.source = 'SELLER_PORTAL' AND t.source_ref = s.id::text
       WHERE t.id IS NULL OR s.updated_at > t.synced_at
       ORDER BY s.created_at LIMIT ${BATCH}`;
    for (const { id } of due) await this.copySellerTicket(id);
  }

  /** Copies one seller ticket: a new ticket, or its new messages and status. Safe to call again at any time. */
  async copySellerTicket(sellerTicketId: string): Promise<void> {
    const st = await this.prisma.sellerTicket.findUnique({
      where: { id: sellerTicketId },
      include: {
        messages: { orderBy: { createdAt: 'asc' }, include: { attachments: { select: { fileName: true } } } },
        merchant: { select: { fullName: true, email: true } },
      },
    });
    if (!st) return;
    try {
      const supplierId = await this.suppliers.forMerchant(st.merchantId);
      const supplier = await this.prisma.crmSupplier.findUniqueOrThrow({ where: { id: supplierId }, select: { contactName: true, company: true } });
      const status = SELLER_STATUS[st.status] ?? 'open';
      const members = await this.team.byId();
      const owner = st.assigneeId && members.has(st.assigneeId) ? st.assigneeId : null;
      const body = (m: (typeof st.messages)[number]) =>
        (m.body + (m.attachments.length ? `\n\nAttachments: ${m.attachments.map((a) => a.fileName).join(', ')} (open them in Seller tickets)` : '')).slice(0, 5000);
      const kind = (role: string) => (role === 'SELLER' ? 'requester' : role === 'STAFF' ? 'staff' : 'note');
      const now = new Date();

      const existing = await this.prisma.crmTicket.findUnique({
        where: { source_sourceRef: { source: 'SELLER_PORTAL', sourceRef: st.id } },
        include: { messages: { select: { sourceRef: true } } },
      });

      if (!existing) {
        const priority: TicketPriority = st.urgent ? 'urgent' : 'normal';
        const lastSeller = [...st.messages].reverse().find((m) => m.authorRole === 'SELLER');
        const t = await this.prisma.crmTicket.create({
          data: {
            subject: st.subject.slice(0, 200),
            category: SELLER_TOPIC[st.topic] ?? 'Other',
            priority,
            status,
            channel: 'Seller Portal',
            requesterKind: 'supplier',
            supplierId,
            requesterName: (st.merchant.fullName || supplier.contactName || supplier.company).slice(0, 200),
            requesterEmail: st.merchant.email,
            ownerId: owner,
            slaDueAt: slaDue(lastSeller?.createdAt ?? st.createdAt, priority),
            lastMessageAt: st.lastMessageAt,
            solvedAt: status === 'solved' ? (st.resolvedAt ?? now) : null,
            source: 'SELLER_PORTAL',
            sourceRef: st.id,
            externalRef: st.reference,
            syncedAt: now,
            createdAt: st.createdAt,
            messages: {
              create: st.messages.map((m) => ({ kind: kind(m.authorRole), authorId: m.authorId, authorName: m.authorName, body: body(m), sourceRef: `m:${m.id}`, createdAt: m.createdAt })),
            },
          },
        });
        await logActivity(this.prisma, { supplierId }, 'ticket', `Opened ticket ${ticketRef(t.number)}: ${st.subject}`, null, st.createdAt);
        return;
      }

      const known = new Set(existing.messages.map((m) => m.sourceRef));
      const fresh = st.messages.filter((m) => !known.has(`m:${m.id}`));
      if (fresh.length) {
        await this.prisma.crmTicketMessage.createMany({
          data: fresh.map((m) => ({ ticketId: existing.id, kind: kind(m.authorRole), authorId: m.authorId, authorName: m.authorName, body: body(m), sourceRef: `m:${m.id}`, createdAt: m.createdAt })),
          skipDuplicates: true,
        });
      }
      const sellerWroteAgain = fresh.some((m) => m.authorRole === 'SELLER');
      await this.prisma.crmTicket.update({
        where: { id: existing.id },
        data: {
          status,
          solvedAt: status === 'solved' ? (existing.solvedAt ?? st.resolvedAt ?? now) : null,
          lastMessageAt: st.lastMessageAt,
          syncedAt: now,
          // They wrote back: the clock starts again from their message.
          ...(sellerWroteAgain && status === 'open' ? { slaDueAt: slaDue(fresh.filter((m) => m.authorRole === 'SELLER').at(-1)!.createdAt, existing.priority as TicketPriority) } : {}),
          ...(existing.ownerId === null && owner ? { ownerId: owner } : {}),
        },
      });
    } catch (e) {
      if (!isUniqueViolation(e)) throw e; // another instance copied it first
    }
  }
}
