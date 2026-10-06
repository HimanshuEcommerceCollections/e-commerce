import express, { Router } from 'express';
import { currentUser, requireAuth, requireRole } from '../auth/auth.middleware';
import { created, ok } from '../common/api-response';
import { ORDER_STATUSES, USER_ROLES, type UserRole } from '../common/enums';
import { parsePageable } from '../common/pagination';
import { parseBody, pathUuid, ValidationError } from '../common/validation';
import type { Container } from '../container';
import { staffActor } from '../order/order-events';
import { ADMIN_CUSTOMER_SORTS, RoleUpdateSchema } from './customers.service';
import {
  ADMIN_ORDER_SORTS,
  AdminCancelSchema,
  CreateShipmentSchema,
  FulfilmentStepSchema,
  isFulfilmentStatus,
  TrackingEventSchema,
  type AdminOrderFilter,
} from './orders.service';
import { SALES_REPORT_DAYS } from './reports.service';
import { ADMIN_RETURN_SORTS, AdminReturnCreateSchema, isReturnStatus, ReturnActionSchema } from './returns.service';

/**
 * Admin operations API (FR-AD-02/04/06/07/08, FR-IN-03/04/05): orders,
 * fulfilment, shipping, cancellation, returns and refunds, customers and
 * staff roles, analytics, reports and settings. ROLE_ADMIN only — catalog
 * staff get 403 (FR-AD-08). Mounted at /api/admin next to the catalog admin
 * routes; the guard is per route so catalog paths fall through untouched.
 */
export function adminOpsRoutes(c: Container): Router {
  const r = Router();
  const admin = [requireAuth, requireRole('ROLE_ADMIN')];
  const actor = (req: express.Request) => staffActor(currentUser(req));
  const query = (req: express.Request, name: string) => {
    const v = req.query[name];
    return typeof v === 'string' && v.trim() !== '' ? v.trim() : undefined;
  };

  const orderFilter = (req: express.Request): AdminOrderFilter => {
    const status = query(req, 'status');
    if (status !== undefined && !(ORDER_STATUSES as readonly string[]).includes(status)) {
      throw new ValidationError({ status: `must be one of ${ORDER_STATUSES.join(', ')}` });
    }
    const fulfilmentStatus = query(req, 'fulfilmentStatus');
    if (fulfilmentStatus !== undefined && !isFulfilmentStatus(fulfilmentStatus)) {
      throw new ValidationError({ fulfilmentStatus: 'must be one of UNFULFILLED, PICKED, PACKED, SHIPPED, DELIVERED' });
    }
    return { search: query(req, 'search'), status, fulfilmentStatus };
  };
  const orderPageable = (req: express.Request) =>
    parsePageable(req, { sort: 'createdAt,desc', allowedSorts: ADMIN_ORDER_SORTS });

  const csv = (res: express.Response, name: string, body: string) => {
    const day = new Date().toISOString().slice(0, 10);
    // BOM so Excel reads UTF-8 names correctly.
    res.type('text/csv; charset=utf-8').attachment(`${name}-${day}.csv`).send(`﻿${body}`);
  };

  // ── Orders and fulfilment ────────────────────────────────────────────────

  r.get('/orders', ...admin, async (req, res) => {
    res.json(ok(await c.adminOrders.list(orderFilter(req), orderPageable(req))));
  });
  r.get('/orders/stats', ...admin, async (_req, res) => {
    res.json(ok(await c.adminOrders.stats()));
  });
  r.get('/orders/export', ...admin, async (req, res) => {
    csv(res, 'orders', await c.adminOrders.exportCsv(orderFilter(req), orderPageable(req).sort));
  });
  r.get('/orders/:id', ...admin, async (req, res) => {
    res.json(ok(await c.adminOrders.get(String(req.params.id))));
  });
  r.post('/orders/:id/pay', ...admin, async (req, res) => {
    res.json(ok(await c.adminOrders.markPaid(pathUuid(req.params.id), actor(req)), 'Order marked as paid'));
  });
  r.post('/orders/:id/fulfilment', ...admin, async (req, res) => {
    const id = pathUuid(req.params.id);
    const input = parseBody(FulfilmentStepSchema, req.body);
    res.json(ok(await c.adminOrders.fulfilmentStep(id, input, actor(req)), `Order marked ${input.status}`));
  });
  r.post('/orders/:id/shipments', ...admin, async (req, res) => {
    const id = pathUuid(req.params.id);
    const input = parseBody(CreateShipmentSchema, req.body);
    res.status(201).json(created(await c.adminOrders.createShipment(id, input, actor(req)), 'Shipment created'));
  });
  r.post('/shipments/:id/events', ...admin, async (req, res) => {
    const id = pathUuid(req.params.id);
    const input = parseBody(TrackingEventSchema, req.body);
    res.json(ok(await c.adminOrders.addTrackingEvent(id, input, actor(req)), 'Tracking updated'));
  });
  r.post('/orders/:id/cancel', ...admin, async (req, res) => {
    const id = pathUuid(req.params.id);
    const input = parseBody(AdminCancelSchema, req.body);
    res.json(ok(await c.adminOrders.cancel(id, input, actor(req)), 'Order cancelled'));
  });

  // ── Returns and refunds (FR-AD-07) ───────────────────────────────────────

  r.post('/orders/:id/returns', ...admin, async (req, res) => {
    const id = pathUuid(req.params.id);
    const input = parseBody(AdminReturnCreateSchema, req.body);
    res.status(201).json(created(await c.adminReturns.open(id, input, actor(req)), 'Return opened'));
  });
  r.get('/returns', ...admin, async (req, res) => {
    const status = query(req, 'status');
    if (status !== undefined && !isReturnStatus(status)) {
      throw new ValidationError({ status: 'must be one of REQUESTED, APPROVED, REJECTED, RECEIVED, REFUNDED' });
    }
    const pageable = parsePageable(req, { sort: 'createdAt,desc', allowedSorts: ADMIN_RETURN_SORTS });
    res.json(ok(await c.adminReturns.list(status, pageable)));
  });
  r.get('/returns/:id', ...admin, async (req, res) => {
    res.json(ok(await c.adminReturns.get(pathUuid(req.params.id))));
  });
  r.post('/returns/:id/actions', ...admin, async (req, res) => {
    const id = pathUuid(req.params.id);
    const input = parseBody(ReturnActionSchema, req.body);
    res.json(ok(await c.adminReturns.act(id, input, actor(req)), 'Return updated'));
  });

  // ── Customers and staff (FR-AD-06/08) ────────────────────────────────────

  const customerFilter = (req: express.Request) => {
    const role = query(req, 'role');
    if (role !== undefined && !(USER_ROLES as readonly string[]).includes(role)) {
      throw new ValidationError({ role: `must be one of ${USER_ROLES.join(', ')}` });
    }
    return { search: query(req, 'search'), role: role as UserRole | undefined };
  };
  const customerPageable = (req: express.Request) =>
    parsePageable(req, { sort: 'createdAt,desc', allowedSorts: ADMIN_CUSTOMER_SORTS });

  r.get('/customers', ...admin, async (req, res) => {
    res.json(ok(await c.adminCustomers.list(customerFilter(req), customerPageable(req))));
  });
  r.get('/customers/export', ...admin, async (req, res) => {
    csv(res, 'customers', await c.adminCustomers.exportCsv(customerFilter(req), customerPageable(req).sort));
  });
  r.get('/customers/:id', ...admin, async (req, res) => {
    res.json(ok(await c.adminCustomers.get(pathUuid(req.params.id))));
  });
  r.patch('/users/:id/role', ...admin, async (req, res) => {
    const id = pathUuid(req.params.id);
    const { role } = parseBody(RoleUpdateSchema, req.body);
    res.json(ok(await c.adminCustomers.setRole(id, role, currentUser(req).id), 'Role updated'));
  });

  // ── Analytics, reports, settings ─────────────────────────────────────────

  r.get('/analytics/summary', ...admin, async (req, res) => {
    res.json(ok(await c.adminReports.analyticsSummary({ from: query(req, 'from'), to: query(req, 'to') })));
  });
  r.get('/reports/sales', ...admin, async (req, res) => {
    const days = Number(query(req, 'days') ?? 30);
    if (!(SALES_REPORT_DAYS as readonly number[]).includes(days)) {
      throw new ValidationError({ days: `must be one of ${SALES_REPORT_DAYS.join(', ')}` });
    }
    res.json(ok(await c.adminReports.salesReport(days)));
  });
  r.get('/settings', ...admin, (_req, res) => {
    res.json(ok(c.adminReports.settings()));
  });

  return r;
}
