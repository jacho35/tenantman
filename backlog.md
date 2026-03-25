# Tenantman - Product Backlog

## Phase 2: QuickBooks Online Integration

- [ ] Register OAuth2 client at developer.intuit.com
- [ ] Implement OAuth2 authorization flow (access + refresh tokens)
- [ ] Build token refresh middleware
- [ ] Push generated invoices to QBO via API
- [ ] Match tenants to QBO customers by email
- [ ] Show push status per invoice (Draft / Pushed / Failed)
- [ ] QBO connection status indicator (replace placeholder red dot)

## Electricity Billing

- [ ] Create electricity tariff configuration (bands or flat rate)
- [ ] Build electricity cost calculation engine (similar to water)
- [ ] Include electricity line items in invoice generation
- [ ] Display electricity cost estimate on meter reading form

## Invoice Export & Delivery

- [ ] PDF export per tenant per period
- [ ] Bulk PDF export (all tenants for a period)
- [ ] Email invoices to tenants directly from the app
- [ ] Invoice history / archive view

## Reporting

- [ ] Monthly billing summary dashboard (totals, per-tenant breakdown)
- [ ] Water usage trend graphs per tenant
- [ ] Tenant payment aging / outstanding balance tracking
- [ ] Variance report (month-over-month changes)

## Data Integrity & Validation

- [ ] Server-side input validation on all API endpoints
- [ ] Duplicate meter reading detection / warning
- [ ] Prevent generating invoices for finalized periods without confirmation
- [ ] Rate limiting on API endpoints

## Audit & History

- [ ] Audit log for all data changes (who, what, when)
- [ ] Invoice revision history (track re-generations)
- [ ] Meter reading change log

## Backup & Recovery

- [ ] Automated database backup (scheduled SQLite snapshots)
- [ ] Backup restore mechanism
- [ ] Data export to CSV / JSON

## Testing

- [ ] Unit tests for billing engine (stepped tariffs, ESKOM splitting)
- [ ] API integration tests for all endpoints
- [ ] End-to-end tests for billing workflow
- [ ] Regression tests against validated invoice totals (Invoice 1103: R11,564.81, Invoice 1102: R14,582.66)

## UX Improvements

- [ ] Improve table layouts on small mobile screens
- [ ] Add loading spinners during invoice generation
- [ ] Keyboard shortcuts for common actions
- [ ] Confirmation dialogs before destructive actions (delete tenant, regenerate invoice)
- [ ] Period finalization workflow (lock readings + line items)

## Infrastructure

- [ ] Migrate from sql.js (in-memory) to better-sqlite3 or PostgreSQL for larger deployments
- [ ] Add health-check endpoint for Docker monitoring
- [ ] Environment-based configuration (dev / staging / production)
- [ ] Structured logging (request logs, error logs)
