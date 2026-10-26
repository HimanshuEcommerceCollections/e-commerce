import type { PrismaClient } from '@prisma/client';
import { money } from '../common/api-response';
import type { Pageable } from '../common/pagination';
import type { OrderService } from '../order/order.service';
import type { CustomerReturnService } from './returns.service';
import type { SavedItemService } from './saved-items.service';

const FIRST: Pageable = { page: 0, size: 1, sort: [] };

/** The account home ("Hi, Jordan"): counts for the tiles and the order to feature. */
export class AccountSummaryService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly orders: OrderService,
    private readonly returns: CustomerReturnService,
    private readonly savedItems: SavedItemService,
  ) {}

  async summary(userId: string) {
    const [user, counts, openReturns, savedItems, open] = await Promise.all([
      this.prisma.user.findUniqueOrThrow({ where: { id: userId }, select: { createdAt: true, storeCreditBalance: true } }),
      this.orders.countMyOrders(userId),
      this.returns.countOpen(userId),
      this.savedItems.count(userId),
      this.orders.findMyOrders(userId, FIRST, { status: 'open' }),
    ]);
    // The most recent open order, else the most recent one.
    const latest = open.content[0] ?? (counts.all ? (await this.orders.findMyOrders(userId, FIRST)).content[0] : undefined);
    return {
      memberSince: user.createdAt,
      orders: { total: counts.all, open: counts.open },
      openReturns,
      savedItems,
      storeCreditBalance: money(user.storeCreditBalance),
      latestOrder: latest ?? null,
    };
  }
}
