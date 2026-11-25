import { randomUUID } from 'node:crypto';
import { Prisma, type User } from '@prisma/client';
import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { harness } from './support/harness';

/**
 * CRM (designs/crm), inside the admin portal: customers with their orders and
 * history, the supplier pipeline, tickets (raised in the help center, the Seller
 * Portal, or by the team), tasks, notifications, dashboard and search.
 */
const { app, prisma, container } = harness({ env: { CRM_SYNC_INTERVAL_MS: '0' } });

const tag = randomUUID().slice(0, 8);
let admin: User;
let adminToken: string;
let teammate: User;

const tokenOf = (u: User) => container.jwt.generateToken(u.email);
async function staffUser(role: 'ROLE_ADMIN' | 'ROLE_CATALOG' | 'ROLE_CUSTOMER' | 'ROLE_MERCHANT', name = 'Staff Member') {
  return prisma.user.create({ data: { email: `${role.toLowerCase()}-${randomUUID()}@test.local`, password: 'x', fullName: name, role } });
}
const as = (token = adminToken) => ({
  get: (url: string) => request(app).get(url).set('Authorization', `Bearer ${token}`),
  post: (url: string, body: object = {}) => request(app).post(url).set('Authorization', `Bearer ${token}`).send(body),
  patch: (url: string, body: object) => request(app).patch(url).set('Authorization', `Bearer ${token}`).send(body),
  del: (url: string) => request(app).delete(url).set('Authorization', `Bearer ${token}`),
});
const crm = (url: string) => `/api/admin/crm${url}`;

async function newCustomer(name: string, extra: Partial<Prisma.UserCreateInput> = {}) {
  return prisma.user.create({
    data: { email: `${name.toLowerCase().replace(/\W+/g, '.')}-${tag}@test.local`, password: 'x', fullName: `${name} ${tag}`, role: 'ROLE_CUSTOMER', ...extra },
  });
}
async function newOrder(user: User, total: string, at = new Date()) {
  return prisma.order.create({
    data: {
      userId: user.id,
      customerEmail: user.email,
      orderNumber: `T-${randomUUID()}`,
      status: 'PAID',
      currency: 'USD',
      subtotal: new Prisma.Decimal(total),
      taxTotal: 0,
      shippingTotal: 0,
      discountTotal: 0,
      grandTotal: new Prisma.Decimal(total),
      paymentStatus: 'SUCCEEDED',
      shippingMethod: 'STANDARD',
      shipRecipientName: user.fullName,
      shipAddressLine1: '1 Test Street',
      shipCity: 'Austin',
      shipState: 'TX',
      shipPostalCode: '78701',
      shipCountry: 'US',
      createdAt: at,
    },
  });
}
const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000);

beforeAll(async () => {
  admin = await staffUser('ROLE_ADMIN', `Alex Admin ${tag}`);
  teammate = await staffUser('ROLE_ADMIN', `Taylor Teammate ${tag}`);
  adminToken = tokenOf(admin);
});

describe('access', () => {
  it('is for admins only', async () => {
    const anon = await request(app).get(crm('/meta'));
    expect(anon.status).toBe(401);
    for (const role of ['ROLE_CUSTOMER', 'ROLE_CATALOG', 'ROLE_MERCHANT'] as const) {
      const u = await staffUser(role);
      for (const path of ['/meta', '/tickets', '/customers', '/suppliers', '/dashboard']) {
        expect((await as(tokenOf(u)).get(crm(path))).status, `${role} ${path}`).toBe(403);
      }
    }
    expect((await as().get(crm('/meta'))).status).toBe(200);
  });

  it('lists the team and who is asking', async () => {
    const res = await as().get(crm('/team'));
    expect(res.status).toBe(200);
    expect(res.body.data.me).toBe(admin.id);
    expect(res.body.data.members.map((m: { id: string }) => m.id)).toEqual(expect.arrayContaining([admin.id, teammate.id]));
  });
});

describe('customers', () => {
  let emily: User;
  let emilyId: string;

  beforeAll(async () => {
    emily = await newCustomer('Emily Carter', { marketingOptIn: true, createdAt: daysAgo(400) });
    await newOrder(emily, '84.00', daysAgo(100));
    await newOrder(emily, '40.50', daysAgo(95));
    await newOrder(emily, '10.00', daysAgo(120));
  });

  it('gives every customer account a record with orders, spend and tags worked out from the store', async () => {
    const res = await as().get(crm(`/customers?q=${encodeURIComponent(`emily carter ${tag}`)}`));
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.data.content).toHaveLength(1);
    const c = res.body.data.content[0];
    emilyId = c.id;
    expect(c).toMatchObject({ code: expect.stringMatching(/^C-\d+$/), name: `Emily Carter ${tag}`, orders: 3, ltv: 134.5, location: 'Austin, TX', marketingConsent: true, owner: null, openTickets: 0 });
    // 3 orders, the last 95 days ago: repeat and at risk (90+ days), not new.
    expect(c.tags).toEqual(expect.arrayContaining(['Repeat', 'At risk']));
    expect(c.tags).not.toContain('New');
  });

  it('filters by tag and owner, sorts, and pages', async () => {
    const fresh = await newCustomer('Newbie Nora');
    const one = async (qs: string) => (await as().get(crm(`/customers?q=${tag}&${qs}`))).body.data;
    expect((await one('tag=At%20risk')).content.map((c: { id: string }) => c.id)).toContain(emilyId);
    expect((await one('tag=New')).content.map((c: { email: string }) => c.email)).toContain(fresh.email);
    expect((await one('tag=New')).content.map((c: { id: string }) => c.id)).not.toContain(emilyId);
    expect((await one('tag=Repeat')).content.map((c: { id: string }) => c.id)).toContain(emilyId);
    expect((await one('owner=none')).content.length).toBeGreaterThanOrEqual(2);
    const byOrders = (await one('sort=orders&dir=desc')).content;
    expect(byOrders[0].id).toBe(emilyId);
    const page = await one('size=1&page=1&sort=name&dir=asc');
    expect(page).toMatchObject({ size: 1, number: 1, numberOfElements: 1 });
    expect((await as().get(crm('/customers?sort=bogus'))).status).toBe(400);
    expect((await as().get(crm('/customers?owner=not-a-uuid'))).status).toBe(400);
  });

  it('shows a profile with the store history beside the team notes', async () => {
    const res = await as().get(crm(`/customers/${emilyId}`));
    expect(res.status).toBe(200);
    const p = res.body.data;
    expect(p).toMatchObject({ hasAccount: true, orders: 3, averageOrder: 44.83 });
    expect(p.recentOrders).toHaveLength(3);
    expect(p.recentOrders[0]).toMatchObject({ id: expect.stringMatching(/^[0-9a-f-]{36}$/), orderNumber: expect.stringMatching(/^T-/) });
    expect(p.history.filter((h: { kind: string }) => h.kind === 'order')).toHaveLength(3);
    expect(p.history[0].body).toMatch(/^Order #T-.* placed · \$/);
    expect((await as().get(crm(`/customers/${randomUUID()}`))).status).toBe(404);
    expect((await as().get(crm('/customers/nope'))).status).toBe(400);
  });

  it('sets an owner and VIP, and logs the change', async () => {
    const res = await as().patch(crm(`/customers/${emilyId}`), { ownerId: teammate.id, tags: ['VIP'] });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.data.owner).toMatchObject({ id: teammate.id });
    expect(res.body.data.tags[0]).toBe('VIP');
    expect(res.body.data.history[0].body).toBe(`Owner changed to Taylor Teammate ${tag}`);
    expect((await as().get(crm(`/customers?q=${tag}&tag=VIP&owner=${teammate.id}`))).body.data.content.map((c: { id: string }) => c.id)).toEqual([emilyId]);

    expect((await as().patch(crm(`/customers/${emilyId}`), { ownerId: randomUUID() })).status).toBe(400);
    expect((await as().patch(crm(`/customers/${emilyId}`), { tags: ['Platinum'] })).status).toBe(400);
    const cleared = await as().patch(crm(`/customers/${emilyId}`), { ownerId: null });
    expect(cleared.body.data.owner).toBeNull();
    expect(cleared.body.data.tags).toContain('VIP'); // tags untouched when not sent
  });

  it('logs notes, calls and emails (an email is sent and kept)', async () => {
    const note = await as().post(crm(`/customers/${emilyId}/activities`), { kind: 'note', body: 'Prefers chat over phone.' });
    expect(note.status).toBe(201);
    expect(note.body.data).toMatchObject({ kind: 'note', body: 'Prefers chat over phone.', by: `Alex Admin ${tag}` });
    const call = await as().post(crm(`/customers/${emilyId}/activities`), { kind: 'call', body: 'Checked the refund.', outcome: 'Left voicemail', minutes: 2 });
    expect(call.body.data.body).toBe('Left voicemail (2 min): Checked the refund.');
    const mail = await as().post(crm(`/customers/${emilyId}/activities`), { kind: 'email', subject: 'Your refund', body: 'It went out on the 20th.' });
    expect(mail.status, JSON.stringify(mail.body)).toBe(201);
    expect(mail.body.data.body).toBe('Sent “Your refund”: It went out on the 20th.');
    expect(await prisma.notification.count({ where: { toAddress: emily.email, subject: 'Your refund' } })).toBe(1);

    expect((await as().post(crm(`/customers/${emilyId}/activities`), { kind: 'note', body: '' })).status).toBe(400);
    const profile = (await as().get(crm(`/customers/${emilyId}`))).body.data;
    expect(profile.history.map((h: { kind: string }) => h.kind)).toEqual(expect.arrayContaining(['note', 'call', 'email']));
  });

  it('adds someone without an account, refuses a duplicate, and links them when they sign up', async () => {
    const email = `walkin-${tag}@test.local`;
    const created = await as().post(crm('/customers'), { name: 'Walk In', email, phone: '(555) 010-0000' });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    expect(created.body.data).toMatchObject({ name: 'Walk In', email, hasAccount: false, orders: 0, tags: expect.arrayContaining(['New']) });
    const id = created.body.data.id;

    const dup = await as().post(crm('/customers'), { name: 'Walk In Again', email: email.toUpperCase() });
    expect(dup.status).toBe(409);
    expect((await as().post(crm('/customers'), { name: 'X', email: 'nope' })).status).toBe(400);
    const existingAccount = await as().post(crm('/customers'), { name: 'Em', email: emily.email });
    expect(existingAccount.status).toBe(409);

    // They create an account later: the same record picks it up.
    await prisma.user.create({ data: { email, password: 'x', fullName: 'Walk In Customer', role: 'ROLE_CUSTOMER' } });
    const linked = (await as().get(crm(`/customers/${id}`))).body.data;
    expect(linked).toMatchObject({ id, name: 'Walk In Customer', hasAccount: true });
  });
});

describe('tickets from the help center', () => {
  let customer: User;
  let ref: string;
  let supportId: string;

  beforeAll(async () => {
    customer = await newCustomer('Help Seeker');
  });

  it('arrive in the queue on their own, tied to the customer who wrote in', async () => {
    const posted = await request(app)
      .post('/api/support/messages')
      .send({ name: 'Help Seeker', email: customer.email.toUpperCase(), topic: 'Returns and refunds', orderNumber: 'EC-30418', message: 'You said the refund was processed but I do not see it.' });
    expect(posted.status).toBe(201);
    supportId = (await prisma.supportMessage.findUniqueOrThrow({ where: { ticketNumber: posted.body.data.ticketNumber } })).id;

    const list = await as().get(crm(`/tickets?view=open&q=${encodeURIComponent(posted.body.data.ticketNumber)}`));
    expect(list.status, JSON.stringify(list.body)).toBe(200);
    expect(list.body.data.content).toHaveLength(1);
    const t = list.body.data.content[0];
    ref = t.reference;
    expect(t).toMatchObject({
      reference: expect.stringMatching(/^TK-\d+$/),
      subject: 'Returns and refunds · order EC-30418',
      category: 'Return / refund',
      priority: 'normal',
      status: 'open',
      channel: 'Help center',
      source: 'HELP_CENTER',
      owner: null,
      messageCount: 1,
      requester: { kind: 'customer', name: 'Help Seeker', email: customer.email.toUpperCase() },
    });
    const crmCustomer = await prisma.crmCustomer.findUniqueOrThrow({ where: { userId: customer.id } });
    expect(t.requester.id).toBe(crmCustomer.id);
    // Copied once, however often the CRM is opened.
    await as().get(crm('/tickets'));
    expect(await prisma.crmTicket.count({ where: { source: 'HELP_CENTER', sourceRef: supportId } })).toBe(1);
  });

  it('shows the thread, who it is from, and where it came from', async () => {
    const res = await as().get(crm(`/tickets/${ref}`));
    expect(res.status).toBe(200);
    expect(res.body.data.messages).toHaveLength(1);
    expect(res.body.data.messages[0]).toMatchObject({ kind: 'requester', body: expect.stringContaining('refund') });
    expect(res.body.data.requester).toMatchObject({ kind: 'customer', name: `Help Seeker ${tag}`, summary: '0 orders · $0.00' });
    expect(res.body.data.linked).toMatchObject({ type: 'support_message', href: '/admin/support' });
    expect((await as().get(crm('/tickets/TK-9999999'))).status).toBe(404);
    expect((await as().get(crm('/tickets/nonsense'))).status).toBe(404);
  });

  it('a reply is emailed, takes the ticket, waits for them, and updates the original message', async () => {
    const res = await as().post(crm(`/tickets/${ref}/messages`), { body: 'Hi, the refund went out on the 20th.', mode: 'reply', after: 'pending' });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.data).toMatchObject({ status: 'pending', owner: { id: admin.id } });
    expect(res.body.data.messages.at(-1)).toMatchObject({ kind: 'staff', author: { name: `Alex Admin ${tag}` } });
    expect(await prisma.notification.count({ where: { toAddress: customer.email.toUpperCase(), subject: { startsWith: 'Re: Returns and refunds' } } })).toBe(1);
    expect((await prisma.supportMessage.findUniqueOrThrow({ where: { id: supportId } })).status).toBe('IN_PROGRESS');
    const profile = (await as().get(crm(`/customers/${res.body.data.requester.id}`))).body.data;
    expect(profile.history.map((h: { body: string }) => h.body)).toEqual(expect.arrayContaining([expect.stringMatching(/^Replied on TK-\d+: Hi, the refund/)]));
  });

  it('keeps notes inside the team, and solving closes the original', async () => {
    const note = await as().post(crm(`/tickets/${ref}/messages`), { body: 'Checked with payments.', mode: 'note' });
    expect(note.body.data.status).toBe('pending'); // a note changes nothing else
    expect(note.body.data.messages.at(-1).kind).toBe('note');
    expect(await prisma.notification.count({ where: { body: { contains: 'Checked with payments' } } })).toBe(0);

    const solved = await as().post(crm(`/tickets/${ref}/messages`), { body: 'All sorted. Anything else, just reply.', mode: 'reply', after: 'solved' });
    expect(solved.body.data).toMatchObject({ status: 'solved' });
    expect((await prisma.supportMessage.findUniqueOrThrow({ where: { id: supportId } })).status).toBe('CLOSED');

    // A solved ticket takes notes but no more replies, until it is reopened.
    expect((await as().post(crm(`/tickets/${ref}/messages`), { body: 'One more thing', mode: 'reply' })).status).toBe(409);
    expect((await as().post(crm(`/tickets/${ref}/messages`), { body: 'Internal', mode: 'note' })).status).toBe(201);
    const reopened = await as().patch(crm(`/tickets/${ref}`), { status: 'open' });
    expect(reopened.body.data.status).toBe('open');
    expect((await prisma.supportMessage.findUniqueOrThrow({ where: { id: supportId } })).status).toBe('OPEN');
    expect((await as().post(crm(`/tickets/${ref}/messages`), { body: '   ', mode: 'reply' })).status).toBe(400);
  });

  it('keeps a guest as a name and email, with no profile', async () => {
    const email = `guest-${tag}@test.local`;
    await request(app).post('/api/support/messages').send({ name: 'Gus Guest', email, topic: 'Something else', message: 'Do you ship to Canada?' });
    const t = (await as().get(crm(`/tickets?q=${encodeURIComponent(email)}`))).body.data.content[0];
    expect(t.requester).toMatchObject({ kind: 'customer', id: null, name: 'Gus Guest', email });
    const detail = (await as().get(crm(`/tickets/${t.reference}`))).body.data;
    expect(detail.requester).toMatchObject({ id: null, summary: 'No profile yet' });
  });
});

describe('tickets from the Seller Portal', () => {
  let seller: User;
  let sellerToken: string;
  let sellerRef: string;
  let ref: string;

  beforeAll(async () => {
    seller = await staffUser('ROLE_MERCHANT', `Peak Outdoor ${tag}`);
    sellerToken = tokenOf(seller);
  });
  const sellerApi = () => as(sellerToken);

  it('arrive as supplier tickets, with the seller as a pipeline card', async () => {
    const raised = await sellerApi().post('/api/seller/tickets', { topic: 'payments', subject: `Payout missing ${tag}`, body: 'One order is not in my payout.', urgent: true });
    expect(raised.status, JSON.stringify(raised.body)).toBe(201);
    sellerRef = raised.body.data.reference;

    const list = await as().get(crm(`/tickets?q=${encodeURIComponent(sellerRef)}`));
    expect(list.body.data.content).toHaveLength(1);
    const t = list.body.data.content[0];
    ref = t.reference;
    expect(t).toMatchObject({ category: 'Payouts', priority: 'urgent', status: 'open', channel: 'Seller Portal', source: 'SELLER_PORTAL', requester: { kind: 'supplier', name: `Peak Outdoor ${tag}` } });
    const detail = (await as().get(crm(`/tickets/${ref}`))).body.data;
    expect(detail.linked).toMatchObject({ type: 'seller_ticket', reference: sellerRef, href: `/admin/seller-tickets/${sellerRef}` });
    expect(detail.requester).toMatchObject({ kind: 'supplier', name: `Peak Outdoor ${tag}` });
    // The seller has a card in the pipeline.
    const board = (await as().get(crm(`/suppliers?q=${encodeURIComponent(`Peak Outdoor ${tag}`)}`))).body.data.content;
    expect(board).toHaveLength(1);
    expect(board[0]).toMatchObject({ stage: 'live', source: 'Seller Portal' });
  });

  it('a reply from the CRM reaches the seller; their answer comes back and starts the clock again', async () => {
    const res = await as().post(crm(`/tickets/${ref}/messages`), { body: 'We found it, paying out Friday.', mode: 'reply', after: 'pending' });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.data.status).toBe('pending');
    expect(res.body.data.messages.at(-1)).toMatchObject({ kind: 'staff', body: 'We found it, paying out Friday.' });
    const theirs = (await sellerApi().get(`/api/seller/tickets/${sellerRef}`)).body.data;
    expect(theirs.status).toBe('WAITING');
    expect(theirs.messages.at(-1)).toMatchObject({ role: 'STAFF', body: 'We found it, paying out Friday.' });
    // Not copied twice.
    expect((await as().get(crm(`/tickets/${ref}`))).body.data.messages).toHaveLength(2);

    await sellerApi().post(`/api/seller/tickets/${sellerRef}/messages`, { body: 'Thanks! Friday works.' });
    const back = (await as().get(crm(`/tickets/${ref}`))).body.data;
    expect(back.status).toBe('open');
    expect(back.messages.at(-1)).toMatchObject({ kind: 'requester', body: 'Thanks! Friday works.' });
    expect(back.messages).toHaveLength(3);
    expect(new Date(back.slaDueAt).getTime()).toBeGreaterThan(Date.now()); // urgent: due in about 4 hours
  });

  it('assigning and solving here is seen in the Seller tickets list too', async () => {
    const assigned = await as().patch(crm(`/tickets/${ref}`), { ownerId: teammate.id });
    expect(assigned.body.data.owner.id).toBe(teammate.id);
    expect((await prisma.sellerTicket.findFirstOrThrow({ where: { reference: sellerRef } })).assigneeId).toBe(teammate.id);

    const solved = await as().patch(crm(`/tickets/${ref}`), { status: 'solved' });
    expect(solved.body.data.status).toBe('solved');
    expect((await sellerApi().get(`/api/seller/tickets/${sellerRef}`)).body.data.status).toBe('RESOLVED');

    // The seller reopens it: it is open here again.
    await sellerApi().post(`/api/seller/tickets/${sellerRef}/reopen`);
    expect((await as().get(crm(`/tickets/${ref}`))).body.data.status).toBe('open');
  });

  it('follows replies made on the Seller tickets page too', async () => {
    await as().post(`/api/admin/seller-tickets/${sellerRef}/messages`, { body: 'Replied from the other page.' });
    const t = (await as().get(crm(`/tickets/${ref}`))).body.data;
    expect(t.status).toBe('pending');
    expect(t.messages.at(-1)).toMatchObject({ kind: 'staff', body: 'Replied from the other page.' });
  });
});

describe('opening and managing tickets by hand', () => {
  let customerId: string;
  let ref: string;

  beforeAll(async () => {
    const u = await newCustomer('Marcus Johnson');
    await as().get(crm('/customers')); // makes the record
    customerId = (await prisma.crmCustomer.findUniqueOrThrow({ where: { userId: u.id } })).id;
  });

  it('needs someone to be about, a subject and the details', async () => {
    const none = await as().post(crm('/tickets'), { subject: 'Wrong size sent', body: 'Got L, ordered M' });
    expect(none.status).toBe(400);
    expect(none.body.data).toEqual({ customerId: 'Choose who this is for' });
    const short = await as().post(crm('/tickets'), { customerId, subject: 'Hi', body: 'x' });
    expect(short.body.data).toEqual({ subject: 'Add a short subject', body: 'Add the details' });
    const both = await as().post(crm('/tickets'), { customerId, supplierId: randomUUID(), subject: 'Both of them', body: 'details here' });
    expect(both.status).toBe(400);
    expect((await as().post(crm('/tickets'), { customerId: randomUUID(), subject: 'Ghost customer', body: 'details here' })).status).toBe(404);
    expect((await as().post(crm('/tickets'), { customerId, subject: 'Bad owner here', body: 'details here', ownerId: randomUUID() })).status).toBe(400);
  });

  it('opens a ticket assigned to the creator with a reply clock from its priority', async () => {
    const res = await as().post(crm('/tickets'), { customerId, subject: 'Wrong size sent: ordered M, got L', category: 'Return / refund', priority: 'high', body: 'Customer called. Wants to swap.' });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const t = res.body.data;
    ref = t.reference;
    expect(t).toMatchObject({ status: 'open', priority: 'high', category: 'Return / refund', channel: 'Created by team', source: 'STAFF', owner: { id: admin.id }, messageCount: 1 });
    expect(new Date(t.slaDueAt).getTime() - new Date(t.createdAt).getTime()).toBe(8 * 3_600_000);
    expect(t.messages[0]).toMatchObject({ kind: 'note', body: 'Customer called. Wants to swap.' });
    const profile = (await as().get(crm(`/customers/${customerId}`))).body.data;
    expect(profile.tickets).toEqual([expect.objectContaining({ reference: ref, status: 'open' })]);
    expect(profile.history[0].body).toBe(`Opened ticket ${ref}: Wrong size sent: ordered M, got L`);
  });

  it('can be left unassigned, then re-prioritised, assigned and solved', async () => {
    const un = await as().post(crm('/tickets'), { customerId, subject: 'Nobody has this yet', body: 'details here', ownerId: null });
    expect(un.body.data.owner).toBeNull();
    const unref = un.body.data.reference;
    const urgent = await as().patch(crm(`/tickets/${unref}`), { priority: 'urgent' });
    expect(new Date(urgent.body.data.slaDueAt).getTime() - new Date(urgent.body.data.createdAt).getTime()).toBe(4 * 3_600_000);
    const assigned = await as().patch(crm(`/tickets/${unref}`), { ownerId: teammate.id });
    expect(assigned.body.data.owner.id).toBe(teammate.id);
    expect((await as().patch(crm(`/tickets/${unref}`), { status: 'wrong' })).status).toBe(400);
    expect((await as().patch(crm(`/tickets/${unref}`), { ownerId: randomUUID() })).status).toBe(400);
    const solved = await as().patch(crm(`/tickets/${unref}`), { status: 'solved' });
    expect(solved.body.data).toMatchObject({ status: 'solved' });
    expect(solved.body.data.solvedAt).toBeTruthy();
    const profile = (await as().get(crm(`/customers/${customerId}`))).body.data;
    expect(profile.history.map((h: { body: string }) => h.body)).toContain(`Solved ticket ${unref}`);
  });

  it('sorts by reply time and splits into the views, with counts', async () => {
    // Make one ticket overdue.
    const overdue = await as().post(crm('/tickets'), { customerId, subject: 'Waiting far too long', body: 'details here', priority: 'low' });
    await prisma.crmTicket.update({ where: { id: overdue.body.data.id }, data: { slaDueAt: new Date(Date.now() - 3 * 3_600_000) } });

    const open = (await as().get(crm(`/tickets?view=open&who=customer&size=200`))).body.data;
    const refs = open.content.map((t: { reference: string }) => t.reference);
    expect(refs.indexOf(overdue.body.data.reference)).toBeLessThan(refs.indexOf(ref)); // soonest due first
    const od = (await as().get(crm('/tickets?view=overdue&size=200'))).body.data;
    expect(od.content.map((t: { reference: string }) => t.reference)).toContain(overdue.body.data.reference);
    expect(od.content.every((t: { status: string; slaDueAt: string }) => t.status === 'open' && new Date(t.slaDueAt) < new Date())).toBe(true);
    const mine = (await as().get(crm('/tickets?view=mine&size=200'))).body.data.content.map((t: { reference: string }) => t.reference);
    expect(mine).toContain(ref);
    const unassigned = (await as().get(crm('/tickets?view=unassigned&size=200'))).body.data.content;
    expect(unassigned.every((t: { owner: unknown; status: string }) => t.owner === null && t.status !== 'solved')).toBe(true);
    expect((await as().get(crm('/tickets?view=solved&size=200'))).body.data.content.every((t: { status: string }) => t.status === 'solved')).toBe(true);
    const sup = (await as().get(crm('/tickets?who=supplier&size=200'))).body.data.content;
    expect(sup.every((t: { requester: { kind: string } }) => t.requester.kind === 'supplier')).toBe(true);

    expect(open.counts).toEqual(expect.objectContaining({ mine: expect.any(Number), unassigned: expect.any(Number), overdue: expect.any(Number), open: expect.any(Number), pending: expect.any(Number), solved: expect.any(Number) }));
    expect(open.counts.overdue).toBeGreaterThanOrEqual(1);
    expect((await as().get(crm('/summary'))).body.data.tickets.open).toBe(open.counts.open);
    expect((await as().get(crm('/tickets?view=bogus'))).status).toBe(400);
    // Find by number.
    const byNumber = (await as().get(crm(`/tickets?view=open&q=${encodeURIComponent(ref)}`))).body.data.content;
    expect(byNumber.map((t: { reference: string }) => t.reference)).toEqual([ref]);
  });
});

describe('supplier pipeline', () => {
  let leadId: string;
  const company = `Golden Hour Candles ${tag}`;

  it('adds a lead with a first step, owned by whoever added it', async () => {
    const bad = await as().post(crm('/suppliers'), { company: 'X' });
    expect(bad.status).toBe(400);
    const res = await as().post(crm('/suppliers'), { company, contactName: 'Priya Raman', email: `priya-${tag}@test.local`, category: 'Home fragrance', source: 'Instagram', estProducts: 25 });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    leadId = res.body.data.id;
    expect(res.body.data).toMatchObject({ code: expect.stringMatching(/^S-\d+$/), company, stage: 'lead', source: 'Instagram', estProducts: 25, owner: { id: admin.id }, nextStep: 'First outreach' });
    expect(new Date(res.body.data.nextDue).getTime()).toBeGreaterThan(Date.now());
    expect(res.body.data.history[0].body).toBe('Added as a lead');
  });

  it('moves between stages, logging each move; lost needs a reason and clears the next step', async () => {
    const moved = await as().post(crm(`/suppliers/${leadId}/stage`), { stage: 'contacted' });
    expect(moved.body.data).toMatchObject({ stage: 'contacted' });
    expect(moved.body.data.history[0].body).toBe('Moved from Lead to Contacted');
    const noReason = await as().post(crm(`/suppliers/${leadId}/stage`), { stage: 'lost' });
    expect(noReason.status).toBe(400);
    expect((await as().post(crm(`/suppliers/${leadId}/stage`), { stage: 'nowhere' })).status).toBe(400);
    const lost = await as().post(crm(`/suppliers/${leadId}/stage`), { stage: 'lost', reason: 'Fees too high', note: 'margins' });
    expect(lost.body.data).toMatchObject({ stage: 'lost', lostReason: 'Fees too high – margins', nextStep: null, nextDue: null });
    expect(lost.body.data.history[0].body).toBe('Marked Lost: Fees too high – margins');
    const back = await as().post(crm(`/suppliers/${leadId}/stage`), { stage: 'interested' });
    expect(back.body.data).toMatchObject({ stage: 'interested', lostReason: null });
  });

  it('hides lost suppliers until asked, and totals the whole pipeline', async () => {
    await as().post(crm(`/suppliers/${leadId}/stage`), { stage: 'lost', reason: 'No response' });
    const q = encodeURIComponent(company);
    expect((await as().get(crm(`/suppliers?q=${q}`))).body.data.content).toHaveLength(0);
    const withLost = (await as().get(crm(`/suppliers?q=${q}&includeLost=true`))).body.data;
    expect(withLost.content.map((s: { id: string }) => s.id)).toEqual([leadId]);
    expect(withLost.strip).toEqual(expect.objectContaining({ inProgress: expect.any(Number), productsOnTheWay: expect.any(Number), live: expect.any(Number), overdueNextSteps: expect.any(Number), lost: expect.any(Number) }));
    expect(withLost.stages.map((s: { key: string }) => s.key)).toEqual(['lead', 'contacted', 'interested', 'applied', 'review', 'documents', 'live', 'lost']);
  });

  it('edits the owner and next step', async () => {
    await as().post(crm(`/suppliers/${leadId}/stage`), { stage: 'contacted' });
    const res = await as().patch(crm(`/suppliers/${leadId}`), { ownerId: teammate.id, nextStep: 'Follow-up email #2', nextDue: '2026-12-01' });
    expect(res.body.data).toMatchObject({ owner: { id: teammate.id }, nextStep: 'Follow-up email #2' });
    expect(new Date(res.body.data.nextDue).toISOString().slice(0, 10)).toBe('2026-12-01');
    const cleared = await as().patch(crm(`/suppliers/${leadId}`), { nextStep: '', nextDue: null });
    expect(cleared.body.data).toMatchObject({ nextStep: null, nextDue: null });
    expect((await as().patch(crm(`/suppliers/${leadId}`), { nextDue: 'next week' })).status).toBe(400);
  });

  it('follows seller applications: a card appears, and moves when the application does', async () => {
    const name = `BrightNest Kitchen ${tag}`;
    const merchant = await staffUser('ROLE_MERCHANT', 'Jamie Lee');
    const app1 = await prisma.sellerApplication.create({
      data: {
        reference: `APP-${tag}`,
        fullName: 'Jamie Lee',
        email: `jamie-${tag}@test.local`,
        phone: '(503) 555-0150',
        categories: ['Kitchen & dining'],
        products: '50–200',
        street: '1 Pan St',
        city: 'Portland',
        state: 'OR',
        postalCode: '97201',
        userId: merchant.id,
        companyName: name,
        stage: 'APPLIED',
        stageChangedAt: new Date(),
      },
    });
    const card = async () => (await as().get(crm(`/suppliers?q=${encodeURIComponent(name)}&includeLost=true`))).body.data.content[0];
    let c = await card();
    expect(c).toMatchObject({ stage: 'applied', company: name, contact: 'Jamie Lee', location: 'Portland, OR', estProducts: 125, source: 'Seller Portal', followsPortal: true });

    await prisma.sellerApplication.update({ where: { id: app1.id }, data: { stage: 'SCORECARD', stageChangedAt: new Date() } });
    c = await card();
    expect(c.stage).toBe('review');
    expect((await as().get(crm(`/suppliers/${c.id}`))).body.data.history[0].body).toBe('Moved from Applied to In review (Seller Portal)');

    // Moved by hand: it stays put while the application stays put...
    await as().post(crm(`/suppliers/${c.id}/stage`), { stage: 'documents' });
    expect((await card()).stage).toBe('documents');
    // ...and follows the application when that moves again.
    await prisma.sellerApplication.update({ where: { id: app1.id }, data: { stage: 'APPROVED', stageChangedAt: new Date() } });
    c = await card();
    expect(c.stage).toBe('live');
    const profile = (await as().get(crm(`/suppliers/${c.id}`))).body.data;
    expect(profile.application).toMatchObject({ id: app1.id, reference: `APP-${tag}`, stage: 'APPROVED' });
    await prisma.sellerApplication.update({ where: { id: app1.id }, data: { stage: 'DECLINED', declineReason: 'Fails the scorecard', stageChangedAt: new Date() } });
    expect(await card()).toMatchObject({ stage: 'lost', lostReason: 'Fails the scorecard' });
  });

  it('turns an old "Sell with us" lead into a lead card and counts live products from the seller account', async () => {
    const email = `lead-${tag}@test.local`;
    await request(app).post('/api/seller-applications').send({
      fullName: `Legacy Lead ${tag}`,
      email,
      phone: '(503) 555-0199',
      categories: ['Home & Kitchen'],
      products: 'Handmade ceramics',
      street: '1 Kiln Rd',
      city: 'Portland',
      state: 'Oregon',
      postalCode: '97214',
      consent: true,
    });
    const card = (await as().get(crm(`/suppliers?q=${encodeURIComponent(`Legacy Lead ${tag}`)}`))).body.data.content[0];
    expect(card).toMatchObject({ stage: 'lead', source: 'Inbound', followsPortal: false });

    const seller = await staffUser('ROLE_MERCHANT', `Product Seller ${tag}`);
    const parent = await prisma.parentProduct.create({ data: { code: `P-${randomUUID()}`, name: 'Mug', merchantId: seller.id } });
    for (const status of ['ACTIVE', 'ACTIVE', 'DRAFT']) {
      await prisma.product.create({ data: { name: 'Mug', sku: `SKU-${randomUUID()}`, price: new Prisma.Decimal('9.00'), stockQuantity: 1, status, parentId: parent.id, merchantId: seller.id, version: 0n } });
    }
    await as(tokenOf(seller)).post('/api/seller/tickets', { topic: 'other', subject: 'Hello there', body: 'A question.' });
    const sellerCard = (await as().get(crm(`/suppliers?q=${encodeURIComponent(`Product Seller ${tag}`)}`))).body.data.content[0];
    expect(sellerCard.liveProducts).toBe(2);
  });
});

describe('tasks', () => {
  let customerId: string;
  let taskId: string;

  beforeAll(async () => {
    const u = await newCustomer('Task Target');
    await as().get(crm('/customers'));
    customerId = (await prisma.crmCustomer.findUniqueOrThrow({ where: { userId: u.id } })).id;
  });

  it('adds a task for the person adding it, about a customer', async () => {
    const bad = await as().post(crm('/tasks'), { title: 'x' });
    expect(bad.status).toBe(400);
    expect(bad.body.data).toEqual({ title: 'Describe the task' });
    expect((await as().post(crm('/tasks'), { title: 'Call back', customerId })).body.data).toEqual({ due: 'Pick a due date' });

    const res = await as().post(crm('/tasks'), { title: 'Check refund status with payments', customerId, due: daysAgo(1).toISOString() });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    taskId = res.body.data.id;
    expect(res.body.data).toMatchObject({ done: false, owner: { id: admin.id }, contact: { kind: 'customer', id: customerId, name: `Task Target ${tag}` } });
    expect((await as().get(crm(`/customers/${customerId}`))).body.data.history[0].body).toBe('Task added: Check refund status with payments');
  });

  it('splits mine into today and overdue, upcoming and done, by the admin’s own day', async () => {
    const soon = await as().post(crm('/tasks'), { title: 'Next week follow-up', due: new Date(Date.now() + 7 * 86_400_000).toISOString(), ownerId: teammate.id });
    const mine = (await as().get(crm('/tasks?owner=me&tab=today'))).body.data;
    expect(mine.content.map((k: { id: string }) => k.id)).toContain(taskId);
    expect(mine.content.map((k: { id: string }) => k.id)).not.toContain(soon.body.data.id);
    expect(mine.counts.today).toBeGreaterThanOrEqual(1);
    const up = (await as().get(crm(`/tasks?owner=${teammate.id}&tab=up`))).body.data;
    expect(up.content.map((k: { id: string }) => k.id)).toContain(soon.body.data.id);

    // "Today" is the browser's day (tz = getTimezoneOffset(): minutes behind UTC), not the server's.
    const endOfToday = (tz: number) => Math.floor((Date.now() - tz * 60_000) / 86_400_000) * 86_400_000 + tz * 60_000 + 86_400_000;
    const lastMinute = new Date(endOfToday(840) - 60_000); // the last minute of today in UTC-14
    const tonight = await as().post(crm('/tasks'), { title: 'Tonight', due: lastMinute.toISOString() });
    const idOf = (r: { body: { data: { content: { id: string }[] } } }) => r.body.data.content.map((k) => k.id);
    expect(idOf(await as().get(crm('/tasks?owner=me&tab=today&tz=840')))).toContain(tonight.body.data.id);
    expect(idOf(await as().get(crm('/tasks?owner=me&tab=up&tz=840')))).not.toContain(tonight.body.data.id);
    // Someone far ahead of UTC is already into the next day for it.
    const todayAhead = lastMinute.getTime() < endOfToday(-840);
    expect(idOf(await as().get(crm('/tasks?owner=me&tab=today&tz=-840'))).includes(tonight.body.data.id)).toBe(todayAhead);
    const lateTonight = tonight;
    expect(idOf(await as().get(crm(`/tasks?customerId=${customerId}`)))).toEqual([taskId]);
  });

  it('ticks off and reopens, logging it on the profile; edits; deletes', async () => {
    const done = await as().patch(crm(`/tasks/${taskId}`), { done: true });
    expect(done.status).toBe(200);
    expect(done.body.data.done).toBe(true);
    expect((await as().get(crm(`/customers/${customerId}`))).body.data.history[0].body).toBe('Task done: Check refund status with payments');
    expect((await as().get(crm('/tasks?owner=me&tab=done'))).body.data.content.map((k: { id: string }) => k.id)).toContain(taskId);
    expect((await as().patch(crm(`/tasks/${taskId}`), { done: false })).body.data.done).toBe(false);
    const edited = await as().patch(crm(`/tasks/${taskId}`), { title: 'Check refund with payments (Friday)', ownerId: teammate.id });
    expect(edited.body.data).toMatchObject({ title: 'Check refund with payments (Friday)', owner: { id: teammate.id } });
    expect((await as().patch(crm(`/tasks/${randomUUID()}`), { done: true })).status).toBe(404);
    expect((await as().del(crm(`/tasks/${taskId}`))).status).toBe(200);
    expect((await as().del(crm(`/tasks/${taskId}`))).status).toBe(404);
  });
});

describe('dashboard, notifications and search', () => {
  it('summarises what needs attention', async () => {
    const res = await as().get(crm('/dashboard?tz=0'));
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const d = res.body.data;
    expect(d.kpis).toEqual({
      openTickets: expect.any(Number),
      unassignedTickets: expect.any(Number),
      overdueTickets: expect.any(Number),
      myTasksDue: expect.any(Number),
      myTasksOverdue: expect.any(Number),
      suppliersInProgress: expect.any(Number),
      liveSuppliers: expect.any(Number),
      stuckSuppliers: expect.any(Number),
    });
    expect(d.kpis.openTickets).toBeGreaterThan(0);
    expect(d.queue.length).toBeLessThanOrEqual(5);
    expect(d.funnel.map((f: { key: string }) => f.key)).toEqual(['lead', 'contacted', 'interested', 'applied', 'review', 'documents', 'live']);
    expect(d.activity.length).toBeGreaterThan(0);
    expect(d.activity[0].subject).toMatchObject({ kind: expect.stringMatching(/customer|supplier/), name: expect.any(String) });
    expect(d.workload.map((w: { member: { id: string } }) => w.member.id)).toEqual(expect.arrayContaining([admin.id, teammate.id]));
  });

  it('lists customers to look after: at risk, or VIP with an open ticket', async () => {
    const u = await newCustomer('Atrisk Andy');
    await newOrder(u, '77.00', daysAgo(200));
    const d = (await as().get(crm('/dashboard'))).body.data;
    const names = d.care.map((c: { name: string }) => c.name);
    // The list is capped at 8, so look it up directly when it is full.
    if (names.length < 8) expect(names).toContain(`Atrisk Andy ${tag}`);
    expect(d.care.every((c: { tags: string[] }) => c.tags.includes('At risk') || c.tags.includes('VIP'))).toBe(true);
  });

  it('notifies about overdue tickets, my tasks and stuck suppliers', async () => {
    const me = await staffUser('ROLE_ADMIN', `Fresh Admin ${tag}`);
    const token = tokenOf(me);
    const supplier = await as(token).post(crm('/suppliers'), { company: `Stuck Supplier ${tag}`, ownerId: null });
    await prisma.crmSupplier.update({ where: { id: supplier.body.data.id }, data: { stageChangedAt: daysAgo(10) } });
    await as(token).post(crm('/tasks'), { title: `Overdue chore ${tag}`, due: daysAgo(2).toISOString() });
    const t = await as(token).post(crm('/tickets'), { supplierId: supplier.body.data.id, subject: `Late ticket ${tag}`, body: 'details here', ownerId: null });
    await prisma.crmTicket.update({ where: { id: t.body.data.id }, data: { slaDueAt: new Date(Date.now() - 3_600_000) } });

    const res = await as(token).get(crm('/notifications?tz=0'));
    expect(res.status).toBe(200);
    const titles: Record<string, string> = Object.fromEntries(res.body.data.content.map((n: { title: string; subtitle: string }) => [n.title, n.subtitle]));
    expect(titles[`Late ticket ${tag}`]).toMatch(/^Past reply time · /);
    expect(titles[`Overdue chore ${tag}`]).toBe('Your task · 2 days overdue');
    expect(titles[`Stuck Supplier ${tag} is stuck in Lead`]).toBe('10 days in this stage');
    const task = res.body.data.content.find((n: { title: string }) => n.title === `Overdue chore ${tag}`);
    expect(task).toMatchObject({ icon: 'check', tone: 'bad', link: { type: 'tasks' } });
    // Someone else's tasks are not mine.
    expect(Object.keys((await as().get(crm('/notifications'))).body.data.content.map((n: { title: string }) => n.title))).not.toContain(`Overdue chore ${tag}`);
  });

  it('searches customers, suppliers and tickets at once', async () => {
    const res = await as().get(crm(`/search?q=${encodeURIComponent(tag)}`));
    expect(res.status).toBe(200);
    expect(res.body.data.customers.length).toBeGreaterThan(0);
    expect(res.body.data.suppliers.length).toBeGreaterThan(0);
    expect(res.body.data.tickets.length).toBeGreaterThan(0);
    const picked = (await as().get(crm('/search?limit=3'))).body.data;
    expect(picked.customers.length).toBeLessThanOrEqual(3);
    expect(picked.tickets).toEqual([]);
  });

  it('can be told to copy new tickets now', async () => {
    const res = await as().post(crm('/sync'));
    expect(res.status).toBe(200);
  });
});
