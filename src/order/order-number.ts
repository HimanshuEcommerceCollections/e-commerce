import { randomInt } from 'node:crypto';
import type { Db } from '../db';

/**
 * Customer-facing order numbers: `EC-` + 7 random digits (EC-4821907) — short
 * enough to read over the phone or type into the tracking form. Numbers
 * issued before (NX-MFX3K2A1-1A2B3) stay valid; nothing parses them.
 */
export const ORDER_NUMBER_PATTERN = /^EC-\d{7}$/;

export function randomOrderNumber(): string {
  return `EC-${randomInt(0, 10_000_000).toString().padStart(7, '0')}`;
}

/**
 * Canonical form of what a customer typed: "ec4821907", "EC 4821907" and
 * "#EC-4821907" all become "EC-4821907". Anything else is returned trimmed
 * and upper-cased (legacy NX- numbers).
 */
export function normalizeOrderNumber(input: string): string {
  const t = input.trim().replace(/^#/, '').toUpperCase();
  const m = /^EC[\s-]?(\d{7})$/.exec(t);
  return m ? `EC-${m[1]}` : t;
}

/**
 * A number not used yet. Ten million values make a clash rare; the check plus
 * a few retries makes it practically impossible, and uk_orders_order_number
 * still guards the insert.
 */
export async function generateOrderNumber(db: Db): Promise<string> {
  for (let attempt = 0; attempt < 10; attempt++) {
    const candidate = randomOrderNumber();
    if (!(await db.order.findUnique({ where: { orderNumber: candidate }, select: { id: true } }))) return candidate;
  }
  throw new Error('Unable to generate a unique order number after several attempts');
}

/** Return (RMA) numbers: `RMA-` + 7 random digits, unique (uk_order_returns_rma_number guards the insert). */
export async function generateRmaNumber(db: Db): Promise<string> {
  for (let attempt = 0; attempt < 10; attempt++) {
    const candidate = `RMA-${randomInt(0, 10_000_000).toString().padStart(7, '0')}`;
    if (!(await db.orderReturn.findUnique({ where: { rmaNumber: candidate }, select: { id: true } }))) return candidate;
  }
  throw new Error('Unable to generate a unique RMA number after several attempts');
}
