import type { Db } from '../db';

/**
 * The order timeline (FR-ST-12): one row per state change, written in the
 * same transaction as the change so the history never disagrees with the
 * order. Shared by checkout, payment events, fulfilment, shipping, returns
 * and cancellation.
 */
export interface OrderEventInput {
  status?: string | null;
  fulfilmentStatus?: string | null;
  note?: string | null;
  /** CUSTOMER, GUEST, ADMIN:<email>, SYSTEM, GATEWAY… */
  actor: string;
}

export function recordOrderEvent(db: Db, orderId: string, e: OrderEventInput) {
  return db.orderEvent.create({
    data: {
      orderId,
      status: e.status ?? null,
      fulfilmentStatus: e.fulfilmentStatus ?? null,
      note: e.note?.slice(0, 1000) ?? null,
      actor: e.actor.slice(0, 255),
    },
  });
}

/** Actor label for a staff member, e.g. `ADMIN:ops@example.com`. */
export const staffActor = (user: { role: string; email: string }) =>
  `${user.role.replace(/^ROLE_/, '')}:${user.email}`;
