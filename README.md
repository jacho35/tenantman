# Tenant Invoice Manager

Monthly tenant billing calculator and invoice generator for Rusticworx Property (PTY) Ltd.

## Features

- **Tenant Management** — Store tenant profiles with unit numbers, rental amounts, billing addresses, VAT numbers, and toggle-able extras (internet, electricity)
- **CoCT Water Tariff Engine** — Stepped tariff calculation with separate water and sanitation bands, configurable sanitation factor (default 90%)
- **ESKOM Charge Calculator** — Auto-splits daily rates by number of units, multiplied by days in billing period
- **Monthly Billing Workflow** — 4-step process: Create period → Enter meter readings → Generate invoices → Review
- **Invoice Line Items** — Generates exact line items matching QuickBooks invoice format (rental, water fixed, refuse, water usage with reading narrative, ESKOM service/network/generation, internet)
- **QuickBooks Online Integration** — Phase 2 (API structure ready for OAuth2 connection)

## Validated Accuracy

All calculations verified against actual invoices:
- Invoice 1103 (Unit 1): Subtotal R11,564.81 ✓ EXACT MATCH
- Invoice 1102 (Unit 2): Subtotal R14,582.66 ✓ EXACT MATCH
- Water calc Unit 1 (1.686kl): R59.12 ✓ | Unit 2 (1.258kl): R44.11 ✓ | Unit 3 (1.197kl): R41.97 ✓

## Deployment (Docker)

```bash
# Clone/copy to your server
cd tenant-invoice-manager

# Build and run
docker compose up -d --build

# Access at http://your-server:3456
```

The SQLite database is persisted in the `./data/` directory via a Docker volume mount.

## Deployment (Direct Node.js)

```bash
cd backend
npm install
cd ..
mkdir -p data
node backend/server.js
# Runs on port 3456 (configurable via PORT env var)
```

## Architecture

```
tenant-invoice-manager/
├── backend/
│   ├── server.js        # Express server entry point
│   ├── database.js      # sql.js SQLite wrapper + schema + seed data
│   ├── billing.js       # Water tariff engine + invoice line item generator
│   ├── routes.js        # REST API endpoints
│   └── package.json
├── frontend/
│   ├── index.html       # Single-file PWA (dark theme, all tabs)
│   └── manifest.json    # PWA manifest
├── data/
│   └── invoices.db      # SQLite database (auto-created)
├── docker-compose.yml
├── Dockerfile
└── README.md
```

## API Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/tenants` | List active tenants |
| POST | `/api/tenants` | Create tenant |
| PUT | `/api/tenants/:id` | Update tenant |
| DELETE | `/api/tenants/:id` | Deactivate tenant |
| GET | `/api/tariffs/active` | Get active tariff set with bands |
| PUT | `/api/tariffs/:id` | Update tariff bands and charges |
| GET | `/api/settings` | Get all settings |
| PUT | `/api/settings` | Update settings |
| GET | `/api/billing-periods` | List billing periods |
| POST | `/api/billing-periods` | Create billing period |
| POST | `/api/meter-readings` | Save/update meter reading |
| GET | `/api/meter-readings/last/:tenantId/:type` | Get last reading (auto-fill previous) |
| POST | `/api/generate-all/:periodId` | Generate invoices for all active tenants |
| POST | `/api/calculate-water` | Test water calculation |

## Configuration

Key settings (editable in Settings tab):
- **VAT Rate**: 15% (South Africa)
- **ESKOM Split Units**: 3 (divides daily ESKOM rates across units)
- **Sanitation Factor**: 0.9 (CoCT calculates sanitation on 90% of water usage)
- **Water/Sanitation Tariff Bands**: Editable in Tariffs tab
- **Fixed Charges**: Water fixed, refuse, ESKOM daily rates — all editable

## Phase 2: QuickBooks Integration

The database schema includes `qbo_config` table for OAuth2 credentials. When ready:
1. Register app at https://developer.intuit.com
2. Enter Client ID, Client Secret in Settings
3. OAuth2 flow will handle token exchange and auto-refresh
4. Invoices will be pushed via QBO API matching tenant by email
