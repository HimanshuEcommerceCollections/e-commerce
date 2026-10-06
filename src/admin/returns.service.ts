import { randomInt } from 'node:crypto';
import { Prisma, type PrismaClient } from '@prisma/client';
import { z } from 'zod';
import { money } from '../common/api-response';
import { RETURN_STATUSES, type NotificationTemplate, type ReturnStatus } from '../common/enums';
import { DomainError, InvalidOrderStateError, OrderNotFoundError } from '../common/errors';
import { logger } from '../common/logger';
import { orderBy, skipTake, toPage, type Pageable } from '../common/pagination';
import { decimal, flag, integer, oneOf, optionalString, requiredString, requiredUuid } from '../common/validation';
import type { Config } from '../config';
import { TX, type Db } from '../db';
import type { Mailer } from '../notify/mailer';
import { recordOrderEvent } from '../order/order-events';
import { estimatedRefund, toReturnResponse } from '../order/order.mapper';
import { round2 } from '../order/pricing';
import type { PaymentGateway } from '../payment/gateway';
import { lockOrderRow, restock } from '../order/order.repository';
import { addRefund, addReturnedQuantity } from './order-ops.repository';

const log = logger('admin-returns');

export const ADMIN_RETURN_SORTS = ['createdAt', 'updatedAt', 'status', 'rmaNumber'] as const;
export const RETURN_ACTIONS = ['APPROVE', 'REJECT', 'RECEIVE', 'REFUND'] as const;
export type ReturnAction = (typeof RETURN_ACTIONS)[number];

export const AdminReturnCreateSchema = z.object({
  items: z
    .array(
      z.object({
        orderItemId: requiredUuid(),
        quantity: integer({ required: true, positive: true }),
      }),
      { invalid_type_error: 'must be an array', required_error: 'must not be null' },
    )
    .min(1, 'must not be empty')
    .max(100, 'size must be between 1 and 100'),
  reason: requiredString({ max: 1000 }),
  method: oneOf(['DROPOFF', 'PICKUP'] as const),
});

export const ReturnActionSchema = z.object({
  action: oneOf(RETURN_ACTIONS).refine((v) => v !== undefined, 'must not be null'),
  note: optionalString({ max: 1000 }),
  restock: flag(),
  refundAmount: decimal({ positive: true }),
});

export const isReturnStatus = (v: string): v is ReturnStatus => (RETURN_STATUSES as readonly string[]).includes(v);

/** Orders whose goods have left the warehouse can be returned. */
const RETURNABLE_ORDER = ['SHIPPED', 'DELIVERED'];
/** Returns whose units are still out with the customer (counted against what's left to return). */
const OPEN_RETURN: ReturnStatus[] = ['REQUESTED', 'APPROVED'];

const RETURN_INCLUDE = {
  items: true,
  order: {
    include: {
      items: { where: { deleted: false }, orderBy: { createdAt: 'asc' } },
      user: { select: { fullName: true, email: true } },
    },
  },
} satisfies Prisma.OrderReturnInclude;

type ReturnRow = Prisma.OrderReturnGetPayload<{ include: typeof RETURN_INCLUDE }>;

/**
 * Returns and refunds (FR-AD-07): REQUESTED → APPROVED → RECEIVED → REFUNDED,
 * or REJECTED. Receiving may put the units back on the shelf (a RETURN stock
 * movement); refunding pays through the gateway — partial refunds included —
 * and keeps the order's refunded total and payment status in step.
 */
export class AdminReturnService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly gateway: PaymentGateway,
    private readonly mailer: Mailer,
    private readonly config: Config,
  ) {}

  async list(status: ReturnStatus | undefined, pageable: Pageable) {
    const where: Prisma.OrderReturnWhereInput = status ? { status } : {};
    const [rows, total] = await Promise.all([
      this.prisma.orderReturn.findMany({
        where,
        include: RETURN_INCLUDE,
        orderBy: orderBy(pageable),
        ...skipTake(pageable),
      }),
      this.prisma.orderReturn.count({ where }),
    ]);
    return toPage(rows.map((r) => this.toAdminReturn(r)), total, pageable);
  }

  async get(id: string) {
    return this.toAdminReturn(await findReturn(this.prisma, id));
  }

  /**
   * Opens a return on behalf of the customer. The order row lock makes the
   * "no more than is left to return" check safe against a concurrent request.
   * Admins aren't bound by the customer return window.
   */
  async open(orderId: string, input: z.output<typeof AdminReturnCreateSchema>, actor: string) {
    const ids = input.items.map((i) => i.orderItemId);
    if (new Set(ids).size !== ids.length) throw new DomainError(400, 'Each order item may appear only once');

    const created = await this.prisma.$transaction(async (tx) => {
      await lockOrderRow(tx, orderId);
      const order = await tx.order.findFirst({
        where: { id: orderId, deleted: false },
        include: {
          items: { where: { deleted: false } },
          returns: { where: { status: { in: OPEN_RETURN } }, include: { items: true } },
        },
      });
      if (!order) throw new OrderNotFoundError(orderId);
      if (!RETURNABLE_ORDER.includes(order.status)) {
        throw new InvalidOrderStateError(`Only a shipped or delivered order can be returned (current: ${order.status})`);
      }
      const pending = new Map<string, number>();
      for (const r of order.returns) {
        for (const i of r.items) pending.set(i.orderItemId, (pending.get(i.orderItemId) ?? 0) + i.quantity);
      }
      for (const wanted of input.items) {
        const line = order.items.find((i) => i.id === wanted.orderItemId);
        if (!line) throw new DomainError(400, `Order item ${wanted.orderItemId} is not part of order ${order.orderNumber}`);
        const left = line.quantity - line.returnedQuantity - (pending.get(line.id) ?? 0);
        if (wanted.quantity > left) {
          throw new DomainError(400, `Only ${Math.max(left, 0)} of ${line.sku} can still be returned`);
        }
      }

      const ret = await createWithRmaNumber(tx, {
        orderId,
        status: 'REQUESTED',
        reason: input.reason.trim(),
        method: input.method ?? null,
        requestedBy: 'ADMIN',
        items: { create: input.items.map((i) => ({ orderItemId: i.orderItemId, quantity: i.quantity })) },
      });
      await recordOrderEvent(tx, orderId, { note: `Return ${ret.rmaNumber} opened: ${input.reason.trim()}`, actor });
      return ret;
    }, TX.default);

    const row = await findReturn(this.prisma, created.id);
    await this.notify(row, 'RETURN_REQUESTED', `Return ${row.rmaNumber} for order ${row.order.orderNumber}`, [
      `We've opened return ${row.rmaNumber} for your order ${row.order.orderNumber}.`,
      'We will email you the next steps.',
    ]);
    return toReturnResponse(row, row.order.items, this.config.pricing);
  }

  async act(id: string, input: z.output<typeof ReturnActionSchema>, actor: string) {
    const action = input.action as ReturnAction;
    switch (action) {
      case 'APPROVE':
        return this.transition(id, ['REQUESTED'], 'APPROVED', input.note, actor, 'approved');
      case 'REJECT':
        return this.transition(id, ['REQUESTED', 'APPROVED'], 'REJECTED', input.note, actor, 'rejected');
      case 'RECEIVE':
        return this.receive(id, input.restock, input.note, actor);
      case 'REFUND':
        return this.refund(id, input.refundAmount, input.note, actor);
    }
  }

  private async transition(
    id: string,
    from: ReturnStatus[],
    to: ReturnStatus,
    note: string | undefined,
    actor: string,
    verb: string,
  ) {
    const ret = await this.prisma.$transaction(async (tx) => {
      const { count } = await tx.orderReturn.updateMany({
        where: { id, status: { in: from } },
        data: { status: to, ...(note !== undefined ? { adminNote: note } : {}) },
      });
      if (count === 0) throw await stateError(tx, id, to);
      const row = await findReturn(tx, id);
      await recordOrderEvent(tx, row.orderId, {
        note: `Return ${row.rmaNumber} ${verb}${note ? `: ${note}` : ''}`,
        actor,
      });
      return row;
    }, TX.default);
    await this.notify(ret, 'RETURN_UPDATE', `Return ${ret.rmaNumber} ${verb}`, [
      `Your return ${ret.rmaNumber} for order ${ret.order.orderNumber} was ${verb}.`,
      ...(note ? [note] : []),
    ]);
    return this.toAdminReturn(ret);
  }

  /** The parcel is back: count the units as returned and optionally restock them. */
  private async receive(id: string, restockUnits: boolean, note: string | undefined, actor: string) {
    const ret = await this.prisma.$transaction(async (tx) => {
      const { count } = await tx.orderReturn.updateMany({
        where: { id, status: { in: ['REQUESTED', 'APPROVED'] } },
        data: {
          status: 'RECEIVED',
          receivedAt: new Date(),
          restocked: restockUnits,
          ...(note !== undefined ? { adminNote: note } : {}),
        },
      });
      if (count === 0) throw await stateError(tx, id, 'RECEIVED');
      const row = await findReturn(tx, id);
      for (const item of row.items) {
        const line = row.order.items.find((i) => i.id === item.orderItemId);
        if (!line || (await addReturnedQuantity(tx, item.orderItemId, item.quantity)) === 0) {
          throw new InvalidOrderStateError(`More units of ${line?.sku ?? item.orderItemId} returned than were bought`);
        }
        if (restockUnits) {
          await restock(tx, [{ productId: line.productId, quantity: item.quantity }], {
            source: 'RETURN',
            reason: `Return ${row.rmaNumber} (order ${row.order.orderNumber})`,
            actor,
          });
        }
      }
      await recordOrderEvent(tx, row.orderId, {
        note: `Return ${row.rmaNumber} received${restockUnits ? ' and restocked' : ''}`,
        actor,
      });
      return findReturn(tx, id);
    }, TX.default);
    await this.notify(ret, 'RETURN_UPDATE', `We received your return ${ret.rmaNumber}`, [
      `Your return ${ret.rmaNumber} for order ${ret.order.orderNumber} has arrived. Your refund is next.`,
    ]);
    return this.toAdminReturn(ret);
  }

  /**
   * Pays the refund through the gateway, then records it. Locks the order (one
   * refund at a time per order, so "what's left" stays true) and the return
   * (so a concurrent reject can't land after the money moved). The gateway
   * call carries a per-return idempotency key: a retry never pays twice.
   */
  private async refund(id: string, requested: Prisma.Decimal | undefined, note: string | undefined, actor: string) {
    const head = await this.prisma.orderReturn.findUnique({ where: { id }, select: { orderId: true } });
    if (!head) throw returnNotFound(id);

    const { row, amount, fully } = await this.prisma.$transaction(async (tx) => {
      await lockOrderRow(tx, head.orderId);
      await tx.$queryRaw`SELECT id FROM order_returns WHERE id = ${id}::uuid FOR UPDATE`;
      const ret = await findReturn(tx, id);
      if (ret.status !== 'APPROVED' && ret.status !== 'RECEIVED') {
        throw new InvalidOrderStateError(`A ${ret.status} return can't be refunded`);
      }
      const order = ret.order;
      if (order.paymentStatus !== 'SUCCEEDED' && order.paymentStatus !== 'PARTIALLY_REFUNDED') {
        throw new InvalidOrderStateError(`Order ${order.orderNumber} has no captured payment to refund (payment: ${order.paymentStatus})`);
      }
      const left = order.grandTotal.sub(order.refundedTotal);
      const amount = round2(requested ?? this.refundDue(ret));
      if (amount.lte(0)) throw new InvalidOrderStateError('Nothing is left to refund on this order');
      if (amount.gt(left)) {
        throw new DomainError(400, `At most ${left.toFixed(2)} ${order.currency} can still be refunded on this order`);
      }
      const reference = order.paymentIntentId ?? order.paymentReference;
      if (!reference) throw new InvalidOrderStateError(`Order ${order.orderNumber} has no payment reference`);

      const refundRef = await this.gateway.refund(reference, amount, order.currency, `refund-${reference}-${ret.rmaNumber}`);
      log.info(`Refund ${refundRef} of ${amount.toFixed(2)} issued for return ${ret.rmaNumber}`);

      await tx.orderReturn.update({
        where: { id },
        data: {
          status: 'REFUNDED',
          refundAmount: amount,
          refundReference: refundRef,
          refundedAt: new Date(),
          ...(note !== undefined ? { adminNote: note } : {}),
        },
      });
      const outcome = await addRefund(tx, order.id, amount);
      if (!outcome) throw new InvalidOrderStateError('The refund would exceed the order total');
      await recordOrderEvent(tx, order.id, {
        status: outcome.status !== order.status ? outcome.status : null,
        note: `Refunded ${amount.toFixed(2)} ${order.currency} for return ${ret.rmaNumber}`,
        actor,
      });
      return { row: await findReturn(tx, id), amount, fully: outcome.paymentStatus === 'REFUNDED' };
    }, TX.checkout);

    await this.notify(row, 'REFUND_ISSUED', `Refund issued for return ${row.rmaNumber}`, [
      `We've refunded ${amount.toFixed(2)} ${row.order.currency} for return ${row.rmaNumber} (order ${row.order.orderNumber}).`,
      fully ? 'Your order is now fully refunded.' : '',
      'It can take 5–10 business days to appear on your statement.',
    ]);
    return this.toAdminReturn(row);
  }

  /** The returned lines' price and tax, capped at what's left on the order. */
  private refundDue(r: ReturnRow) {
    if (r.status === 'REFUNDED' || r.status === 'REJECTED') return new Prisma.Decimal(0);
    const estimate = estimatedRefund(r.items, r.order.items, this.config.pricing.pricesIncludeTax);
    const left = r.order.grandTotal.sub(r.order.refundedTotal);
    return Prisma.Decimal.max(Prisma.Decimal.min(estimate, left), 0);
  }

  private toAdminReturn(r: ReturnRow) {
    const byId = new Map(r.order.items.map((i) => [i.id, i]));
    return {
      ...toReturnResponse(r, r.order.items, this.config.pricing),
      adminNote: r.adminNote,
      refundReference: r.refundReference,
      refundDue: money(this.refundDue(r)),
      updatedAt: r.updatedAt,
      order: {
        id: r.order.id,
        orderNumber: r.order.orderNumber,
        status: r.order.status,
        currency: r.order.currency,
        grandTotal: money(r.order.grandTotal),
        refundedTotal: money(r.order.refundedTotal),
        customer: {
          name: r.order.user?.fullName ?? r.order.shipRecipientName,
          email: r.order.user?.email ?? r.order.customerEmail ?? '',
        },
      },
      lines: r.items.map((i) => {
        const line = byId.get(i.orderItemId);
        return {
          orderItemId: i.orderItemId,
          quantity: i.quantity,
          sku: line?.sku ?? '',
          productName: line?.productName ?? '',
          unitPrice: line ? money(line.unitPrice) : 0,
        };
      }),
    };
  }

  private async notify(r: ReturnRow, template: NotificationTemplate, subject: string, lines: string[]) {
    const to = r.order.customerEmail ?? r.order.user?.email;
    if (!to) return;
    await this.mailer.send({
      template,
      to,
      subject,
      body: [...lines.filter(Boolean), '', this.config.store.name].join('\n'),
      orderId: r.orderId,
      userId: r.order.userId,
    });
  }
}

const returnNotFound = (id: string) => new DomainError(404, `Return ${id} was not found`);

async function findReturn(db: Db, id: string): Promise<ReturnRow> {
  const r = await db.orderReturn.findUnique({ where: { id }, include: RETURN_INCLUDE });
  if (!r || r.order.deleted) throw returnNotFound(id);
  return r;
}

async function stateError(db: Db, id: string, to: ReturnStatus) {
  const current = await db.orderReturn.findUnique({ where: { id }, select: { status: true } });
  if (!current) return returnNotFound(id);
  return new InvalidOrderStateError(`A ${current.status} return can't be moved to ${to}`);
}

/** RMA- + 6 digits not used yet; uk_order_returns_rma_number still guards the insert. */
async function createWithRmaNumber(db: Db, data: Omit<Prisma.OrderReturnUncheckedCreateInput, 'rmaNumber'>) {
  for (let attempt = 0; attempt < 5; attempt++) {
    const rmaNumber = `RMA-${randomInt(0, 1_000_000).toString().padStart(6, '0')}`;
    if (await db.orderReturn.findUnique({ where: { rmaNumber }, select: { id: true } })) continue;
    return db.orderReturn.create({ data: { ...data, rmaNumber } });
  }
  throw new Error('Unable to generate a unique RMA number');
}
