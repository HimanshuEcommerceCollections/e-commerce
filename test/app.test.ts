import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { harness } from './support/harness';

const { app } = harness();

describe('application', () => {
  it('boots against a migrated database and reports healthy', async () => {
    const res = await request(app).get('/actuator/health');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('UP');
  });
});
