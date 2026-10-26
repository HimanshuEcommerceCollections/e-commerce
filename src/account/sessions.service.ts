import type { PrismaClient, UserSession } from '@prisma/client';
import { DomainError } from '../common/errors';
import { isUuid } from '../common/validation';
import type { Db } from '../db';
import { describeDevice } from './sessions.user-agent';

/** Where a sign-in came from: the User-Agent header and the client IP. */
export interface ClientInfo {
  userAgent?: string | null;
  ip?: string | null;
}

/** lastSeenAt is written at most this often, so the per-request check stays one read. */
export const SESSION_TOUCH_INTERVAL_MS = 5 * 60_000;

export class SessionNotFoundError extends DomainError {
  constructor() {
    super(404, 'That session was not found');
  }
}

/**
 * The per-request check behind `authenticate`: one primary-key read, plus a
 * lastSeenAt write at most every five minutes. A token's session must exist,
 * belong to the token's user and not be revoked.
 */
export async function checkSession(db: Db, sessionId: string, userId: string): Promise<boolean> {
  if (!isUuid(sessionId)) return false;
  const row = await db.userSession.findUnique({
    where: { id: sessionId },
    select: { userId: true, revokedAt: true, lastSeenAt: true },
  });
  if (!row || row.userId !== userId || row.revokedAt) return false;
  const now = Date.now();
  if (now - row.lastSeenAt.getTime() >= SESSION_TOUCH_INTERVAL_MS) {
    const stale = new Date(now - SESSION_TOUCH_INTERVAL_MS);
    // Conditional, so concurrent requests write once.
    await db.userSession.updateMany({
      where: { id: sessionId, lastSeenAt: { lte: stale } },
      data: { lastSeenAt: new Date(now) },
    });
  }
  return true;
}

export function toSessionResponse(s: UserSession, currentSessionId: string | null) {
  return {
    id: s.id,
    label: s.label,
    deviceType: s.deviceType,
    // No GeoIP provider yet.
    location: null as string | null,
    lastActiveAt: s.lastSeenAt.toISOString(),
    current: s.id === currentSessionId,
  };
}

/** Signed-in devices ("Where you're signed in"): one row per sign-in, revocable. */
export class SessionService {
  constructor(
    private readonly prisma: PrismaClient,
    /** Sessions unseen for longer than the longest token lifetime are no longer listed. */
    private readonly maxTokenLifetimeMs: number,
  ) {}

  async create(userId: string, client: ClientInfo = {}, db: Db = this.prisma): Promise<UserSession> {
    const device = describeDevice(client.userAgent);
    return db.userSession.create({
      data: {
        userId,
        userAgent: client.userAgent ? client.userAgent.slice(0, 255) : null,
        label: device.label.slice(0, 100),
        deviceType: device.deviceType,
        ip: client.ip ? client.ip.slice(0, 45) : null,
        lastSeenAt: new Date(),
      },
    });
  }

  /** Live sessions, the current one first, then most recently active. */
  async list(userId: string, currentSessionId: string | null) {
    const rows = await this.prisma.userSession.findMany({
      where: {
        userId,
        revokedAt: null,
        lastSeenAt: { gt: new Date(Date.now() - this.maxTokenLifetimeMs) },
      },
      orderBy: { lastSeenAt: 'desc' },
      take: 100,
    });
    return rows
      .map((s) => toSessionResponse(s, currentSessionId))
      .sort((a, b) => Number(b.current) - Number(a.current));
  }

  /** Signs one device out. Revoking the current session works too (it is a sign-out). */
  async revoke(userId: string, sessionId: string): Promise<void> {
    const { count } = await this.prisma.userSession.updateMany({
      where: { id: sessionId, userId },
      data: { revokedAt: new Date() },
    });
    if (count === 0) throw new SessionNotFoundError();
    // Already-revoked rows are fine: the second click of a double click.
  }

  /** Signs out everywhere except `keepSessionId` (null: everywhere). Returns how many were revoked. */
  async revokeOthers(userId: string, keepSessionId: string | null, db: Db = this.prisma): Promise<number> {
    const { count } = await db.userSession.updateMany({
      where: { userId, revokedAt: null, ...(keepSessionId ? { id: { not: keepSessionId } } : {}) },
      data: { revokedAt: new Date() },
    });
    return count;
  }
}
