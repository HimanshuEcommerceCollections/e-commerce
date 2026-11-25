import type { PrismaClient } from '@prisma/client';
import type { Config } from '../config';
import type { Mailer } from '../notify/mailer';
import type { SellerTicketService } from '../seller/tickets.service';
import { CrmCustomerService } from './crm.customers.service';
import { CrmIngestService } from './crm.ingest.service';
import { Team } from './crm.shared';
import { CrmSupplierService } from './crm.suppliers.service';
import { CrmTicketService } from './crm.tickets.service';
import { CrmWorkService } from './crm.work.service';

/** The CRM (designs/crm): customers, suppliers, tickets, tasks and the dashboard, for the admin team. */
export interface CrmModule {
  team: Team;
  /** Copies help-center messages, seller tickets and seller applications into the CRM. */
  ingest: CrmIngestService;
  customers: CrmCustomerService;
  suppliers: CrmSupplierService;
  tickets: CrmTicketService;
  /** Tasks, notes and calls, notifications, dashboard and search. */
  work: CrmWorkService;
}

export function createCrm(prisma: PrismaClient, config: Config, mailer: Mailer, sellerTickets: SellerTicketService): CrmModule {
  const team = new Team(prisma, config.crm.syncIntervalMs);
  const customers = new CrmCustomerService(prisma, team, config);
  const suppliers = new CrmSupplierService(prisma, team, config);
  const ingest = new CrmIngestService(prisma, config, team, customers, suppliers);
  const tickets = new CrmTicketService(prisma, team, mailer, config, sellerTickets, ingest, customers);
  const work = new CrmWorkService(prisma, team, mailer, config, customers, suppliers, tickets);
  return { team, ingest, customers, suppliers, tickets, work };
}
