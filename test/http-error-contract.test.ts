import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { harness } from './support/harness';

/**
 * The HTTP error contract: denied requests are 401/403 in the ApiResponse
 * envelope, never an empty body or a 500. (HttpErrorContractIT)
 */
const { app, fixtures } = harness();

describe('HTTP error contract', () => {
  it('missing token is a 401 in the API envelope', async () => {
    const res = await request(app).get('/api/cart');
    expect(res.status).toBe(401);
    expect(res.body).toMatchObject({ success: false, message: 'Authentication required' });
  });

  it('garbage token is a 401, not a 500', async () => {
    const res = await request(app).get('/api/cart').set('Authorization', 'Bearer not-a-jwt');
    expect(res.status).toBe(401);
  });

  it('wrong role is a 403 in the API envelope', async () => {
    const customer = await fixtures.registerUser();

    const merchantOnly = await request(app).get('/api/products/my').set('Authorization', `Bearer ${customer}`);
    expect(merchantOnly.status).toBe(403);
    expect(merchantOnly.body.success).toBe(false);

    const adminOnly = await request(app)
      .post('/api/categories')
      .set('Authorization', `Bearer ${customer}`)
      .send({ name: 'X', slug: `x-${Date.now()}` });
    expect(adminOnly.status).toBe(403);
  });

  it('anonymous writes on public paths are 403, as Spring method security answered', async () => {
    const res = await request(app).post('/api/products').send({ name: 'x', price: 1, stockQuantity: 1, sku: 'x' });
    expect(res.status).toBe(403);
    expect(res.body.message).toBe('You do not have permission to perform this action');
  });

  it('an invalid body is a 400 before the role check, in Spring order', async () => {
    const anonymous = await request(app).post('/api/products').send({ name: 'x' });
    expect(anonymous.status).toBe(400);
    expect(anonymous.body.data).toMatchObject({ price: 'must not be null', sku: 'must not be blank' });

    const customer = await fixtures.registerUser();
    const wrongRole = await request(app).post('/api/categories').set('Authorization', `Bearer ${customer}`).send({});
    expect(wrongRole.status).toBe(400);
  });

  it('health probe is public', async () => {
    const res = await request(app).get('/actuator/health');
    expect(res.status).toBe(200);
  });

  it('validation errors list each field with the Java messages', async () => {
    const res = await request(app).post('/api/auth/register').send({ email: 'not-an-email', password: 'short' });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({
      success: false,
      message: 'Validation failed',
      data: {
        email: 'Must be a valid email address',
        password: 'Password must be between 8 and 100 characters',
        fullName: 'Full name is required',
        phoneNumber: 'Phone number is required',
      },
    });
  });

  it('malformed JSON and malformed ids are 400s', async () => {
    const json = await request(app).post('/api/auth/login').set('Content-Type', 'application/json').send('{"email":');
    expect(json.status).toBe(400);

    const id = await request(app).get('/api/products/not-a-uuid');
    expect(id.status).toBe(400);
    expect(id.body.data).toEqual({ id: 'must be a valid UUID' });
  });
});
