/**
 * Seed historical billing data from QuickBooks Sales report.
 * Run once after fresh DB init: node backend/seed-history.js
 */
const { getDb, get, all, run } = require('./database');

const MONTH_MAP = {
  'Jan': 1, 'Feb': 2, 'Mar': 3, 'Apr': 4, 'May': 5, 'Jun': 6,
  'June': 6, 'Jul': 7, 'July': 7, 'Aug': 8, 'August': 8,
  'Sep': 9, 'Sept': 9, 'Oct': 10, 'Nov': 11, 'Dec': 12
};

// Historical invoices extracted from QB Sales by Customer Type Detail report
// Each entry is one invoice with water reading and ESKOM days
const history = [
  { inv: 1077, unit: 1, label: 'Apr 2025', prevR: 125182, currR: 127753, kl: 2.571, prevDate: '19-Feb-25', currDate: '24-Mar-25', days: 31 },
  { inv: 1078, unit: 2, label: 'Apr 2025', prevR: 8574,   currR: 9131,   kl: 0.557, prevDate: '19-Feb-25', currDate: '24-Mar-25', days: 31 },
  { inv: 1080, unit: 2, label: 'May 2025', prevR: 9131,   currR: 9676,   kl: 0.545, prevDate: '24-Mar-25', currDate: '24-Apr-25', days: 31 },
  { inv: 1081, unit: 1, label: 'May 2025', prevR: 127753, currR: 129657, kl: 1.904, prevDate: '24-Mar-25', currDate: '24-Apr-25', days: 30 },
  { inv: 1083, unit: 2, label: 'Jun 2025', prevR: 9676,   currR: 10982,  kl: 1.306, prevDate: '24-Apr-25', currDate: '27-May-25', days: 30 },
  { inv: 1084, unit: 1, label: 'Jun 2025', prevR: 129657, currR: 131630, kl: 1.973, prevDate: '24-Apr-25', currDate: '27-May-25', days: 31 },
  { inv: 1086, unit: 2, label: 'Jul 2025', prevR: 10982,  currR: 11896,  kl: 0.914, prevDate: '27-May-25', currDate: '26-Jun-25', days: 31 },
  { inv: 1087, unit: 1, label: 'Jul 2025', prevR: 131630, currR: 133754, kl: 2.124, prevDate: '27-May-25', currDate: '26-Jun-25', days: 30 },
  { inv: 1088, unit: 1, label: 'Aug 2025', prevR: 133754, currR: 134690, kl: 0.936, prevDate: '26-Jun-25', currDate: '24-Jul-25', days: 31 },
  { inv: 1089, unit: 2, label: 'Aug 2025', prevR: 11896,  currR: 12987,  kl: 1.091, prevDate: '26-Jun-25', currDate: '24-Jul-25', days: 31 },
  { inv: 1090, unit: 2, label: 'Sep 2025', prevR: 12987,  currR: 14083,  kl: 1.096, prevDate: '24-Jul-25', currDate: '27-Aug-25', days: 30 },
  { inv: 1091, unit: 1, label: 'Sep 2025', prevR: 134690, currR: 137314, kl: 2.624, prevDate: '24-Jul-25', currDate: '27-Aug-25', days: 31 },
  { inv: 1092, unit: 1, label: 'Oct 2025', prevR: 137314, currR: 139710, kl: 2.396, prevDate: '27-Aug-25', currDate: '26-Sep-25', days: 31 },
  { inv: 1093, unit: 2, label: 'Oct 2025', prevR: 14083,  currR: 15422,  kl: 1.339, prevDate: '27-Aug-25', currDate: '26-Sep-25', days: 30 },
  { inv: 1094, unit: 2, label: 'Nov 2025', prevR: 15422,  currR: 16093,  kl: 0.671, prevDate: '26-Sep-25', currDate: '25-Oct-25', days: 30 },
  { inv: 1095, unit: 1, label: 'Nov 2025', prevR: 139710, currR: 141453, kl: 1.743, prevDate: '26-Sep-25', currDate: '25-Oct-25', days: 31 },
  { inv: 1096, unit: 1, label: 'Dec 2025', prevR: 141453, currR: 143281, kl: 1.828, prevDate: '25-Oct-25', currDate: '24-Nov-25', days: 30 },
  { inv: 1097, unit: 2, label: 'Dec 2025', prevR: 16093,  currR: 17604,  kl: 1.511, prevDate: '25-Oct-25', currDate: '24-Nov-25', days: 31 },
  { inv: 1098, unit: 1, label: 'Jan 2026', prevR: 143281, currR: 144599, kl: 1.318, prevDate: '24-Nov-25', currDate: '17-Dec-25', days: 31 },
  { inv: 1099, unit: 2, label: 'Jan 2026', prevR: 17604,  currR: 18820,  kl: 1.216, prevDate: '24-Nov-25', currDate: '17-Dec-25', days: 31 },
  { inv: 1100, unit: 1, label: 'Feb 2026', prevR: 144599, currR: 145951, kl: 1.352, prevDate: '17-Dec-25', currDate: '20-Jan-26', days: 31 },
  { inv: 1101, unit: 2, label: 'Feb 2026', prevR: 18820,  currR: 19193,  kl: 0.373, prevDate: '17-Dec-25', currDate: '20-Jan-26', days: 28 },
  { inv: 1102, unit: 2, label: 'Mar 2026', prevR: 19193,  currR: 20451,  kl: 1.258, prevDate: '20-Jan-26', currDate: '20-Feb-26', days: 31 },
  { inv: 1103, unit: 1, label: 'Mar 2026', prevR: 145951, currR: 147637, kl: 1.686, prevDate: '20-Jan-26', currDate: '20-Feb-26', days: 28 },
];

async function seed() {
  await getDb();

  // Check tenants exist
  const tenants = all("SELECT id, unit_number FROM tenants");
  if (tenants.length === 0) {
    console.log('No tenants found. Please create tenants first (run the app and add them via UI).');
    process.exit(1);
  }
  const unitToId = {};
  tenants.forEach(t => unitToId[t.unit_number] = t.id);
  console.log('Tenant mapping:', unitToId);

  // Group history by billing month label to create shared periods
  const periodMap = {};
  for (const h of history) {
    if (!periodMap[h.label]) {
      periodMap[h.label] = { label: h.label, prevDate: h.prevDate, currDate: h.currDate, days: h.days, readings: [] };
    }
    periodMap[h.label].readings.push(h);
    // Use the max days if units differ (ESKOM billing cycle mismatch)
    if (h.days > periodMap[h.label].days) periodMap[h.label].days = h.days;
  }

  let created = 0;
  for (const [label, period] of Object.entries(periodMap)) {
    // Parse month/year from label like "Apr 2025"
    const parts = label.split(' ');
    const monthNum = MONTH_MAP[parts[0]];
    const year = parseInt(parts[1]);
    if (!monthNum || !year) { console.log('  Skipping unparseable label:', label); continue; }

    // Short label for DB (e.g. "Apr 2025")
    const shortLabel = label;

    // Check if period already exists
    const existing = get("SELECT id FROM billing_periods WHERE year = ? AND month = ?", [year, monthNum]);
    let periodId;
    if (existing) {
      periodId = existing.id;
      console.log(`  Period ${shortLabel} already exists (id=${periodId})`);
    } else {
      const daysInMonth = new Date(year, monthNum, 0).getDate();
      const r = run("INSERT INTO billing_periods (year, month, billing_month_label, days_in_month, previous_reading_date, current_reading_date, status) VALUES (?,?,?,?,?,?,?)",
        [year, monthNum, shortLabel, daysInMonth, period.prevDate, period.currDate, 'finalized']);
      periodId = r.lastInsertRowid;
      console.log(`  Created period ${shortLabel} (id=${periodId}, ${daysInMonth} days)`);
    }

    // Insert meter readings
    for (const reading of period.readings) {
      const tenantId = unitToId[reading.unit];
      if (!tenantId) { console.log(`    No tenant for unit ${reading.unit}, skipping`); continue; }

      const existingReading = get("SELECT id FROM meter_readings WHERE billing_period_id=? AND tenant_id=? AND meter_type='water'", [periodId, tenantId]);
      if (existingReading) {
        console.log(`    Reading already exists for Unit ${reading.unit} in ${shortLabel}`);
        continue;
      }

      run("INSERT INTO meter_readings (billing_period_id, tenant_id, meter_type, previous_reading, current_reading, usage_kl) VALUES (?,?,?,?,?,?)",
        [periodId, tenantId, 'water', reading.prevR, reading.currR, reading.kl]);
      console.log(`    Unit ${reading.unit}: ${reading.prevR} -> ${reading.currR} (${reading.kl} kl) [INV ${reading.inv}]`);
      created++;
    }
  }

  console.log(`\nDone! Created ${Object.keys(periodMap).length} billing periods with ${created} meter readings.`);
}

seed().catch(e => { console.error(e); process.exit(1); });
