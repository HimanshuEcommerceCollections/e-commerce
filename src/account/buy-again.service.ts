import type { PrismaClient } from '@prisma/client';
import { toPage, type Pageable } from '../common/pagination';
import { SHOPPER_PRODUCT_INCLUDE, toShopperProduct } from './shopper-product';

/**
 * "Buy again": every SKU the customer has received (DELIVERED, or REFUNDED
 * after delivery), once each, most recently bought first. Only SKUs still on
 * sale are offered; their live price and stock show, not the old snapshot.
 */
export class BuyAgainService {
  constructor(private readonly prisma: PrismaClient) {}

  async list(userId: string, pageable: Pageable) {
    const [rows, totals] = await Promise.all([
      this.prisma.$queryRaw<{ productId: string; lastBoughtAt: Date }[]>`
        SELECT oi.product_id AS "productId", MAX(o.created_at) AS "lastBoughtAt"
          FROM order_items oi
          JOIN orders o ON o.id = oi.order_id
          JOIN products p ON p.id = oi.product_id
         WHERE o.user_id = ${userId}::uuid AND o.deleted = false AND oi.deleted = false
           AND o.status IN ('DELIVERED', 'REFUNDED')
           AND p.deleted = false AND p.status = 'ACTIVE'
         GROUP BY oi.product_id
         ORDER BY MAX(o.created_at) DESC, oi.product_id
         LIMIT ${pageable.size} OFFSET ${pageable.page * pageable.size}`,
      this.prisma.$queryRaw<{ total: bigint }[]>`
        SELECT COUNT(DISTINCT oi.product_id) AS total
          FROM order_items oi
          JOIN orders o ON o.id = oi.order_id
          JOIN products p ON p.id = oi.product_id
         WHERE o.user_id = ${userId}::uuid AND o.deleted = false AND oi.deleted = false
           AND o.status IN ('DELIVERED', 'REFUNDED')
           AND p.deleted = false AND p.status = 'ACTIVE'`,
    ]);
    const products = await this.prisma.product.findMany({
      where: { id: { in: rows.map((r) => r.productId) } },
      include: SHOPPER_PRODUCT_INCLUDE,
    });
    const byId = new Map(products.map((p) => [p.id, p]));
    const content = rows.flatMap((r) => {
      const p = byId.get(r.productId);
      return p ? [{ ...toShopperProduct(p), lastBoughtAt: r.lastBoughtAt }] : [];
    });
    return toPage(content, Number(totals[0]?.total ?? 0), pageable);
  }
}
