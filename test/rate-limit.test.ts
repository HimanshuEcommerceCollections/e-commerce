import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { harness } from './support/harness';

/** Auth endpoints throttle by client IP once the bucket is drained. (RateLimitIT) */
const { app } = harness({
  env: { RATE_LIMIT_ENABLED: 'true', RATE_LIMIT_AUTH_CAPACITY: '3', RATE_LIMIT_AUTH_REFILL_PER_MINUTE: '1' },
});

describe('auth rate limiting', () => {
  it('login attempts beyond the bucket are 429', async () => {
    const badLogin = { email: 'nobody@test.local', password: 'wrong-password' };
    for (let attempt = 1; attempt <= 3; attempt++) {
      const res = await request(app).post('/api/auth/login').send(badLogin);
      expect(res.status, `attempt ${attempt} should pass the limiter`).toBe(401);
    }
    const throttled = await request(app).post('/api/auth/login').send(badLogin);
    expect(throttled.status).toBe(429);
    expect(throttled.body.success).toBe(false);
  });

  it('non-auth endpoints are never throttled', async () => {
    for (let i = 0; i < 5; i++) {
      expect((await request(app).get('/api/categories')).status).toBe(200);
    }
  });
});
