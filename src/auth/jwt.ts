import jwt, { type Algorithm } from 'jsonwebtoken';

export interface TokenClaims {
  email: string;
  issuedAtSeconds: number | null;
  /** The user_sessions row the token belongs to; null for tokens minted before sessions existed. */
  sessionId: string | null;
}

/**
 * Stateless HMAC JWTs, compatible with the Java server's jjwt tokens: subject
 * is the user's email, and the algorithm follows the secret's length as jjwt's
 * `Keys.hmacShaKeyFor` did (≥ 64 bytes → HS512, ≥ 48 → HS384, else HS256), so
 * tokens issued by either server verify on the other during the switch-over.
 * The extra `sid` claim (the session) is ignored by the Java server.
 */
export class JwtService {
  private readonly key: Buffer;
  private readonly algorithm: Algorithm;
  private readonly accepted: Algorithm[];

  constructor(
    secret: string,
    readonly expirationMs: number,
  ) {
    this.key = Buffer.from(secret, 'utf8');
    if (this.key.length < 32) {
      throw new Error('JWT secret must be at least 32 bytes (256 bits)');
    }
    this.algorithm = this.key.length >= 64 ? 'HS512' : this.key.length >= 48 ? 'HS384' : 'HS256';
    // Any HMAC variant the key is long enough for, like jjwt's verifyWith(key).
    this.accepted = (['HS256', 'HS384', 'HS512'] as const).filter(
      (a) => this.key.length * 8 >= Number(a.slice(2)),
    );
  }

  /** @param options.lifetimeMs defaults to JWT_EXPIRATION_MS ("keep me signed in" passes a longer one). */
  generateToken(email: string, options: { sessionId?: string | null; lifetimeMs?: number } = {}): string {
    const nowMs = Date.now();
    return jwt.sign(
      {
        sub: email,
        ...(options.sessionId ? { sid: options.sessionId } : {}),
        iat: Math.floor(nowMs / 1000),
        exp: Math.floor((nowMs + (options.lifetimeMs ?? this.expirationMs)) / 1000),
      },
      this.key,
      // iat is set above; jsonwebtoken keeps it (noTimestamp would strip it,
      // and the password-change check needs it).
      { algorithm: this.algorithm },
    );
  }

  /** The token's subject (email), or null if it is malformed, forged or expired. */
  verify(token: string): string | null {
    return this.verifyClaims(token)?.email ?? null;
  }

  /** Subject, issue time (whole seconds) and session, or null if the token is malformed, forged or expired. */
  verifyClaims(token: string): TokenClaims | null {
    try {
      const payload = jwt.verify(token, this.key, { algorithms: this.accepted });
      if (typeof payload !== 'object' || typeof payload.sub !== 'string') return null;
      // Tokens minted without iat: their issue time is exp minus the lifetime.
      const issuedAtSeconds =
        typeof payload.iat === 'number'
          ? payload.iat
          : typeof payload.exp === 'number'
            ? payload.exp - Math.floor(this.expirationMs / 1000)
            : null;
      const sessionId = typeof payload.sid === 'string' ? payload.sid : null;
      return { email: payload.sub, issuedAtSeconds, sessionId };
    } catch {
      return null;
    }
  }
}
