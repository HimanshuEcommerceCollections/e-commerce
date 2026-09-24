import jwt, { type Algorithm } from 'jsonwebtoken';

/**
 * Stateless HMAC JWTs, compatible with the Java server's jjwt tokens: subject
 * is the user's email, and the algorithm follows the secret's length as jjwt's
 * `Keys.hmacShaKeyFor` did (≥ 64 bytes → HS512, ≥ 48 → HS384, else HS256), so
 * tokens issued by either server verify on the other during the switch-over.
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

  generateToken(email: string): string {
    const nowMs = Date.now();
    return jwt.sign(
      {
        sub: email,
        iat: Math.floor(nowMs / 1000),
        exp: Math.floor((nowMs + this.expirationMs) / 1000),
      },
      this.key,
      { algorithm: this.algorithm, noTimestamp: true },
    );
  }

  /** The token's subject (email), or null if it is malformed, forged or expired. */
  verify(token: string): string | null {
    try {
      const payload = jwt.verify(token, this.key, { algorithms: this.accepted });
      return typeof payload === 'object' && typeof payload.sub === 'string' ? payload.sub : null;
    } catch {
      return null;
    }
  }
}
