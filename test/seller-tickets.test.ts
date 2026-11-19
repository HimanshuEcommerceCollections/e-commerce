import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { harness } from './support/harness';

/**
 * Seller Help & support (designs/seller/seller-support.html): raising a ticket
 * routed by topic, the reply thread on both sides with attachments, statuses
 * (with our team / waiting for you / resolved), and privacy between sellers.
 */
const { app, prisma, fixtures } = harness();

let seller: string;
let otherSeller: string;
let catalogStaff: string;
let sellerId: string;

const auth = (token: string) => `Bearer ${token}`;

beforeAll(async () => {
  seller = await fixtures.registerUser('ROLE_MERCHANT');
  otherSeller = await fixtures.registerUser('ROLE_MERCHANT');
  catalogStaff = await fixtures.registerUser('ROLE_CATALOG');
  sellerId = (await request(app).get('/api/users/me').set('Authorization', auth(seller))).body.data?.id;
});

describe('seller tickets', () => {
  it('raises a ticket with an attachment, routed to the team for its topic', async () => {
    const res = await request(app)
      .post('/api/seller/tickets')
      .set('Authorization', auth(seller))
      .field('topic', 'payments')
      .field('subject', 'Payout missing one order')
      .field('body', 'Order EC-1 was delivered but is not in my payout.')
      .field('urgent', 'true')
      .attach('files', Buffer.from('%PDF-1.4 test'), 'statement.pdf');
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.data).toMatchObject({
      reference: expect.stringMatching(/^T-\d+$/),
      topic: 'payments',
      topicLabel: 'Payments & payouts',
      team: 'Payments',
      status: 'OPEN',
      urgent: true,
      messageCount: 1,
    });
    const att = res.body.data.messages[0].attachments[0];
    expect(att).toMatchObject({ fileName: 'statement.pdf', contentType: 'application/pdf' });

    const file = await request(app).get(`/api/seller/tickets/${res.body.data.reference}/attachments/${att.id}`).set('Authorization', auth(seller));
    expect(file.status).toBe(200);
    expect(file.headers['content-type']).toContain('application/pdf');
    // Other sellers see nothing of it.
    expect((await request(app).get(`/api/seller/tickets/${res.body.data.reference}`).set('Authorization', auth(otherSeller))).status).toBe(404);
    expect((await request(app).get(`/api/seller/tickets/${res.body.data.reference}/attachments/${att.id}`).set('Authorization', auth(otherSeller))).status).toBe(404);
  });

  it('refuses a missing topic, an unsupported file and something that is not theirs', async () => {
    const base = () => request(app).post('/api/seller/tickets').set('Authorization', auth(seller));
    expect((await base().send({ subject: 'Hi', body: 'Help' })).status).toBe(400);
    const exe = await base().field('topic', 'other').field('subject', 'S').field('body', 'B').attach('files', Buffer.from('MZ'), 'tool.exe');
    expect(exe.status).toBe(400);
    const notMine = await base().send({ topic: 'orders', subject: 'S', body: 'B', relatedType: 'order', relatedRef: 'NOPE-123' });
    expect(notMine.status).toBe(400);
  });

  it('goes back and forth: staff reply waits for the seller, a seller reply goes back to the team, resolve and reopen', async () => {
    const created = await request(app)
      .post('/api/seller/tickets')
      .set('Authorization', auth(seller))
      .send({ topic: 'products', subject: 'Price change rejected', body: 'Why was my price rejected?' });
    const ref = created.body.data.reference;
    expect(created.body.data.team).toBe('Catalog team');

    // Catalog staff see it in the team's open list.
    const list = await request(app).get('/api/admin/seller-tickets?tab=open').set('Authorization', auth(catalogStaff));
    expect(list.status).toBe(200);
    expect(list.body.data.content.some((t: { reference: string }) => t.reference === ref)).toBe(true);

    const reply = await request(app)
      .post(`/api/admin/seller-tickets/${ref}/messages`)
      .set('Authorization', auth(catalogStaff))
      .send({ body: 'It is 42% below your live price. Can you confirm?' });
    expect(reply.status, JSON.stringify(reply.body)).toBe(200);
    expect(reply.body.data).toMatchObject({ status: 'WAITING', assignee: expect.any(String), seller: { email: expect.any(String) } });
    // The seller is emailed.
    expect(await prisma.notification.count({ where: { template: 'SUPPORT_TICKET', userId: sellerId, subject: { contains: ref } } })).toBe(1);

    const waiting = await request(app).get('/api/seller/tickets?tab=waiting').set('Authorization', auth(seller));
    expect(waiting.body.data.counts.waiting).toBeGreaterThanOrEqual(1);
    expect((await request(app).get('/api/seller/tickets/waiting-count').set('Authorization', auth(seller))).body.data.waiting).toBeGreaterThanOrEqual(1);

    const answer = await request(app).post(`/api/seller/tickets/${ref}/messages`).set('Authorization', auth(seller)).field('body', 'Yes, clearing old stock.');
    expect(answer.body.data).toMatchObject({ status: 'OPEN', messageCount: 3 });
    expect(answer.body.data.messages.map((m: { role: string }) => m.role)).toEqual(['SELLER', 'STAFF', 'SELLER']);

    expect((await request(app).post(`/api/seller/tickets/${ref}/messages`).set('Authorization', auth(seller)).send({})).status).toBe(400);

    const resolved = await request(app).post(`/api/seller/tickets/${ref}/resolve`).set('Authorization', auth(seller));
    expect(resolved.body.data.status).toBe('RESOLVED');
    expect((await request(app).post(`/api/seller/tickets/${ref}/messages`).set('Authorization', auth(seller)).send({ body: 'one more' })).status).toBe(409);
    const reopened = await request(app).post(`/api/seller/tickets/${ref}/reopen`).set('Authorization', auth(seller));
    expect(reopened.body.data).toMatchObject({ status: 'OPEN', resolvedAt: null });

    // Staff can resolve with a closing note.
    const done = await request(app).post(`/api/admin/seller-tickets/${ref}/messages`).set('Authorization', auth(catalogStaff)).send({ body: 'Approved now.', resolve: true });
    expect(done.body.data.status).toBe('RESOLVED');
  });

  it('keeps the staff side to staff', async () => {
    expect((await request(app).get('/api/admin/seller-tickets').set('Authorization', auth(seller))).status).toBe(403);
  });
});
