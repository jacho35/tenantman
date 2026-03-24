const initSqlJs = require('sql.js');
const fs = require('fs');
const path = require('path');

const DB_PATH = path.join(__dirname, '..', 'data', 'invoices.db');
let db = null;

async function getDb() {
  if (db) return db;
  const SQL = await initSqlJs();
  if (fs.existsSync(DB_PATH)) {
    db = new SQL.Database(fs.readFileSync(DB_PATH));
  } else {
    db = new SQL.Database();
  }
  db.run("PRAGMA foreign_keys = ON");
  initSchema();
  seedDefaults();
  persist();
  return db;
}

function persist() {
  if (!db) return;
  const dir = path.dirname(DB_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(DB_PATH, Buffer.from(db.export()));
}

function run(sql, params = []) {
  db.run(sql, params);
  const r = db.exec("SELECT last_insert_rowid() as id");
  const lastId = r[0]?.values[0]?.[0] || 0;
  persist();
  return { lastInsertRowid: lastId };
}

function get(sql, params = []) {
  const stmt = db.prepare(sql);
  if (params.length) stmt.bind(params);
  if (stmt.step()) { const row = stmt.getAsObject(); stmt.free(); return row; }
  stmt.free();
  return null;
}

function all(sql, params = []) {
  const stmt = db.prepare(sql);
  if (params.length) stmt.bind(params);
  const results = [];
  while (stmt.step()) results.push(stmt.getAsObject());
  stmt.free();
  return results;
}

function initSchema() {
  const tables = `
    CREATE TABLE IF NOT EXISTS tenants (id INTEGER PRIMARY KEY AUTOINCREMENT, unit_number INTEGER NOT NULL, name TEXT NOT NULL, email TEXT NOT NULL, billing_address TEXT, vat_number TEXT, rental_amount REAL NOT NULL DEFAULT 0, water_meter_id TEXT, elec_meter_id TEXT, has_internet INTEGER NOT NULL DEFAULT 0, has_electricity INTEGER NOT NULL DEFAULT 0, internet_amount REAL NOT NULL DEFAULT 200, utility_month_offset INTEGER NOT NULL DEFAULT 0, is_placeholder INTEGER NOT NULL DEFAULT 0, is_active INTEGER NOT NULL DEFAULT 1, created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now')));
    CREATE TABLE IF NOT EXISTS tariff_sets (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, effective_from TEXT NOT NULL, effective_to TEXT, is_active INTEGER NOT NULL DEFAULT 1, created_at TEXT DEFAULT (datetime('now')));
    CREATE TABLE IF NOT EXISTS water_tariff_bands (id INTEGER PRIMARY KEY AUTOINCREMENT, tariff_set_id INTEGER NOT NULL, band_type TEXT NOT NULL, band_order INTEGER NOT NULL, from_kl REAL NOT NULL, to_kl REAL NOT NULL, rate_per_kl REAL NOT NULL, FOREIGN KEY (tariff_set_id) REFERENCES tariff_sets(id));
    CREATE TABLE IF NOT EXISTS fixed_charges (id INTEGER PRIMARY KEY AUTOINCREMENT, tariff_set_id INTEGER NOT NULL, charge_type TEXT NOT NULL, description TEXT NOT NULL, amount_per_day REAL, amount_fixed REAL, split_by_units INTEGER NOT NULL DEFAULT 1, FOREIGN KEY (tariff_set_id) REFERENCES tariff_sets(id));
    CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT DEFAULT (datetime('now')));
    CREATE TABLE IF NOT EXISTS billing_periods (id INTEGER PRIMARY KEY AUTOINCREMENT, year INTEGER NOT NULL, month INTEGER NOT NULL, billing_month_label TEXT NOT NULL, days_in_month INTEGER NOT NULL, previous_reading_date TEXT, current_reading_date TEXT, status TEXT NOT NULL DEFAULT 'draft', created_at TEXT DEFAULT (datetime('now')), UNIQUE(year, month));
    CREATE TABLE IF NOT EXISTS meter_readings (id INTEGER PRIMARY KEY AUTOINCREMENT, billing_period_id INTEGER NOT NULL, tenant_id INTEGER NOT NULL, meter_type TEXT NOT NULL, previous_reading REAL NOT NULL, current_reading REAL NOT NULL, usage_kl REAL, calculated_amount REAL, FOREIGN KEY (billing_period_id) REFERENCES billing_periods(id), FOREIGN KEY (tenant_id) REFERENCES tenants(id), UNIQUE(billing_period_id, tenant_id, meter_type));
    CREATE TABLE IF NOT EXISTS invoice_line_items (id INTEGER PRIMARY KEY AUTOINCREMENT, billing_period_id INTEGER NOT NULL, tenant_id INTEGER NOT NULL, line_order INTEGER NOT NULL, activity TEXT NOT NULL, description TEXT NOT NULL, tax_type TEXT NOT NULL DEFAULT 'Standard', qty REAL NOT NULL DEFAULT 1, rate REAL NOT NULL, amount REAL NOT NULL, FOREIGN KEY (billing_period_id) REFERENCES billing_periods(id), FOREIGN KEY (tenant_id) REFERENCES tenants(id));
    CREATE TABLE IF NOT EXISTS qbo_config (id INTEGER PRIMARY KEY, client_id TEXT, client_secret TEXT, realm_id TEXT, access_token TEXT, refresh_token TEXT, token_expires_at TEXT, refresh_token_expires_at TEXT, is_connected INTEGER NOT NULL DEFAULT 0, updated_at TEXT DEFAULT (datetime('now')));
  `;
  for (const stmt of tables.split(';').filter(s => s.trim())) {
    db.run(stmt.trim() + ';');
  }
}

function seedDefaults() {
  const c = get("SELECT COUNT(*) as c FROM settings");
  if (c.c === 0) {
    const defs = [
      ['company_name', 'Rusticworx Property (PTY) Ltd'],
      ['company_address', '35 Stillewater Street\nDurbanville Industrial\nWestern Cape 7550 ZA'],
      ['company_email', 'admin@rusticworx.co.za'],
      ['company_vat', '4910306531'],
      ['bank_name', 'Standard Bank'], ['bank_account', '10177172639'],
      ['bank_branch', 'AMANZIMTOTI'], ['bank_branch_code', '051001'],
      ['vat_rate', '15'], ['eskom_split_units', '3'],
      ['property_address', '35 Stillewater Street'],
      ['sanitation_factor', '0.9'],
    ];
    for (const [k, v] of defs) db.run("INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)", [k, v]);
  }

  const tc = get("SELECT COUNT(*) as c FROM tariff_sets");
  if (tc.c === 0) {
    db.run("INSERT INTO tariff_sets (name, effective_from, is_active) VALUES (?, ?, 1)", ['CoCT 2025/2026', '2025-07-01']);
    const tsId = db.exec("SELECT last_insert_rowid()")[0].values[0][0];
    const bands = [
      [tsId,'water',1,0,6.115068,21.15],[tsId,'water',2,6.115078,10.701370,29.06],
      [tsId,'water',3,10.701371,35.671233,43.44],[tsId,'water',4,35.671243,45.863014,83.80],
      [tsId,'water',5,45.863015,137.589044,83.80],
      [tsId,'sanitation',1,0,4.280548,15.46],[tsId,'sanitation',2,4.280558,7.490959,21.24],
      [tsId,'sanitation',3,7.490960,24.969863,32.80],[tsId,'sanitation',4,24.969873,35.671233,53.95],
    ];
    for (const b of bands) db.run("INSERT INTO water_tariff_bands (tariff_set_id,band_type,band_order,from_kl,to_kl,rate_per_kl) VALUES (?,?,?,?,?,?)", b);
    const charges = [
      [tsId,'water_fixed','Water Fixed Charge',null,130.70,1],
      [tsId,'refuse','Refuse Collection Fixed Charge',null,213.30,1],
      [tsId,'eskom_service','ESKOM - Service and Administration Charge @ R14.70 per day',14.70,null,3],
      [tsId,'eskom_network','ESKOM - Network Capacity Charge @ R30.21per day',30.21,null,3],
      [tsId,'eskom_generation','ESKOM - Generation Capacity Charge @ R2.95 per day',2.95,null,3],
    ];
    for (const c of charges) db.run("INSERT INTO fixed_charges (tariff_set_id,charge_type,description,amount_per_day,amount_fixed,split_by_units) VALUES (?,?,?,?,?,?)", c);
  }

  const qc = get("SELECT COUNT(*) as c FROM qbo_config");
  if (qc.c === 0) db.run("INSERT INTO qbo_config (id, is_connected) VALUES (1, 0)");
}

module.exports = { getDb, run, get, all, persist };
