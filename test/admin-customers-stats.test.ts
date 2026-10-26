import { randomUUID } from 'node:crypto';
import { Prisma, type User } from '@prisma/client';
import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { harness } from './support/harness';

/** Admin customers (contract D2): KPI tiles, segments, city search, last order number. */
const { app, prisma, container } = harness();

/** A staff token without going through registration. */
async function tokenFor(role: 'ROLE_ADMIN' | 'ROLE_CATALOG') {
  const user = await prisma.user.create({
    data: { email: `staff-${randomUUID()}@test.local`, password: 'x', fullName: 'Staff Member', role },
  });
  return container.jwt.generateToken(user.email);
}

let admin: string;
const get = (url: string, token = admin) => request(app).get(url).set('Authorization', `Bearer ${token}`);

async function newOrder(user: User, total: string, options: { city?: string; paid?: boolean; at?: Date } = {}) {
  const paid = options.paid ?? true;
  return prisma.order.create({
    data: {
      userId: user.id,
      customerEmail: user.email,
      orderNumber: `T-${randomUUID()}`,
      status: paid ? 'PAID' : 'PENDING_PAYMENT',
      currency: 'USD',
      subtotal: new Prisma.Decimal(total),
      taxTotal: 0,
      shippingTotal: 0,
      discountTotal: 0,
      grandTotal: new Prisma.Decimal(total),
      paymentStatus: paid ? 'SUCCEEDED' : 'PENDING',
      shippingMethod: 'STANDARD',
      shipRecipientName: user.fullName,
      shipAddressLine1: '1 Test Street',
      shipCity: options.city ?? 'Testville',
      shipState: 'TS',
      shipPostalCode: '12345',
      shipCountry: 'US',
      createdAt: options.at,
    },
  });
}

beforeAll(async () => {
  admin = await tokenFor('ROLE_ADMIN');
});

describe('customer stats and segments', () => {
  const tag = randomUUID().slice(0, 8);
  const city = `Bend${tag}`;
  let small: User, big: User, none: User;
  let lastOfBig: string;

  beforeAll(async () => {
    const make = (name: string, optIn: boolean) =>
      prisma.user.create({
        data: { email: `${name}-${tag}@test.local`, password: 'x', fullName: `${name} ${tag}`, role: 'ROLE_CUSTOMER', marketingOptIn: optIn },
      });
    small = await make('small', false);
    big = await make('big', true);
    none = await make('none', false);
    await newOrder(small, '10.00');
    await newOrder(big, '80.00', { at: new Date(Date.now() - 60_000) });
    lastOfBig = (await newOrder(big, '5.00', { paid: false, city })).orderNumber;
  });

  it('computes the KPI tiles and segment counts over the filtered customers', async () => {
    const res = await get(`/api/admin/customers/stats?search=${tag}`);
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({
      customers: 3,
      buyers: 2,
      repeatBuyers: 1,
      repeatRate: 50,
      averageSpend: 45, // (80 + 10) paid / 2 buyers
      marketingOptInRate: 33.3,
      segments: { all: 3, new: 1, repeat: 1, none: 1 },
    });
    // Staff accounts are not customers unless asked for.
    const staff = await get(`/api/admin/customers/stats?search=${tag}&role=ROLE_ADMIN`);
    expect(staff.body.data).toMatchObject({ customers: 0, repeatRate: 0, averageSpend: 0, marketingOptInRate: 0 });
  });

  it('filters the list and the export by segment', async () => {
    const ids = async (segment: string) =>
      (await get(`/api/admin/customers?search=${tag}&segment=${segment}`)).body.data.content.map((c: { id: string }) => c.id);
    expect(await ids('new')).toEqual([small.id]);
    expect(await ids('repeat')).toEqual([big.id]);
    expect(await ids('none')).toEqual([none.id]);
    const page = await get(`/api/admin/customers?search=${tag}&segment=repeat`);
    expect(page.body.data.totalElements).toBe(1);
    expect((await get('/api/admin/customers?segment=vip')).status).toBe(400);

    const csv = await get(`/api/admin/customers/export?search=${tag}&segment=new`);
    const lines = csv.text.replace(/^﻿/, '').trim().split(/\r?\n/);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain('Last order number');
    expect(lines[1]).toContain(small.email);
  });

  it('matches the latest ship city and returns the last order number', async () => {
    const res = await get(`/api/admin/customers?search=${city.toLowerCase()}`);
    expect(res.body.data.content.map((c: { id: string }) => c.id)).toEqual([big.id]);
    expect(res.body.data.content[0]).toMatchObject({ lastOrderNumber: lastOfBig, location: `${city}, TS` });
    const noOrders = await get(`/api/admin/customers?search=none-${tag}`);
    expect(noOrders.body.data.content[0].lastOrderNumber).toBeNull();
  });

  it('is admin only', async () => {
    const catalog = await tokenFor('ROLE_CATALOG');
    expect((await get('/api/admin/customers/stats', catalog)).status).toBe(403);
  });
});
