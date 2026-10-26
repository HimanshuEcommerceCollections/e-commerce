import type { PrismaClient } from '@prisma/client';
import { orderBy, skipTake, toPage, type Pageable } from '../common/pagination';
import type { Config } from '../config';
import { toReturnResponse } from '../order/order.mapper';

export const CUSTOMER_RETURN_SORTS = ['createdAt', 'updatedAt', 'status'] as const;

/** Open returns are the ones still in motion: not yet refunded or rejected. */
export const OPEN_RETURN_STATUSES = ['REQUESTED', 'APPROVED', 'RECEIVED'];

/** The signed-in customer's returns across all their orders ("Returns" tab). */
export class CustomerReturnService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly config: Config,
  ) {}

  async list(userId: string, pageable: Pageable) {
    const where = { order: { userId, deleted: false } };
    const [rows, total] = await Promise.all([
      this.prisma.orderReturn.findMany({
        where,
        include: {
          items: true,
          order: { select: { orderNumber: true, items: { where: { deleted: false }, orderBy: { createdAt: 'asc' } } } },
        },
        orderBy: orderBy(pageable, []),
        ...skipTake(pageable),
      }),
      this.prisma.orderReturn.count({ where }),
    ]);
    return toPage(
      rows.map((r) => toReturnResponse(r, r.order.items, this.config.pricing, r.order)),
      total,
      pageable,
    );
  }

  countOpen(userId: string) {
    return this.prisma.orderReturn.count({
      where: { order: { userId, deleted: false }, status: { in: OPEN_RETURN_STATUSES } },
    });
  }
}
