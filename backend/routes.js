const express = require('express');
const { get, all, run } = require('./database');
const { generateLineItems, saveLineItems, getDaysInMonth, calculateWaterBill } = require('./billing');
const router = express.Router();

router.get('/tenants', (req, res) => res.json(all("SELECT * FROM tenants WHERE is_active = 1 ORDER BY unit_number")));
router.get('/tenants/:id', (req, res) => { const t = get("SELECT * FROM tenants WHERE id = ?", [+req.params.id]); t ? res.json(t) : res.status(404).json({ error: 'Not found' }); });
router.post('/tenants', (req, res) => {
  const b = req.body;
  const r = run("INSERT INTO tenants (unit_number,name,email,billing_address,vat_number,rental_amount,water_meter_id,elec_meter_id,has_internet,has_electricity,internet_amount,utility_month_offset,is_placeholder) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
    [b.unit_number, b.name, b.email, b.billing_address||'', b.vat_number||'', b.rental_amount||0, b.water_meter_id||'', b.elec_meter_id||'', b.has_internet?1:0, b.has_electricity?1:0, b.internet_amount||200, b.utility_month_offset||0, b.is_placeholder?1:0]);
  res.json({ id: r.lastInsertRowid, message: 'Tenant created' });
});
router.put('/tenants/:id', (req, res) => {
  const b = req.body;
  run("UPDATE tenants SET unit_number=?,name=?,email=?,billing_address=?,vat_number=?,rental_amount=?,water_meter_id=?,elec_meter_id=?,has_internet=?,has_electricity=?,internet_amount=?,utility_month_offset=?,is_placeholder=?,updated_at=datetime('now') WHERE id=?",
    [b.unit_number, b.name, b.email, b.billing_address||'', b.vat_number||'', b.rental_amount||0, b.water_meter_id||'', b.elec_meter_id||'', b.has_internet?1:0, b.has_electricity?1:0, b.internet_amount||200, b.utility_month_offset||0, b.is_placeholder?1:0, +req.params.id]);
  res.json({ message: 'Tenant updated' });
});
router.delete('/tenants/:id', (req, res) => { run("UPDATE tenants SET is_active=0,updated_at=datetime('now') WHERE id=?", [+req.params.id]); res.json({ message: 'Tenant deactivated' }); });

router.get('/tariffs', (req, res) => res.json(all("SELECT * FROM tariff_sets ORDER BY effective_from DESC")));
router.get('/tariffs/active', (req, res) => {
  const tariff = get("SELECT * FROM tariff_sets WHERE is_active = 1 ORDER BY effective_from DESC LIMIT 1");
  if (!tariff) return res.status(404).json({ error: 'No active tariff' });
  res.json({ ...tariff,
    waterBands: all("SELECT * FROM water_tariff_bands WHERE tariff_set_id = ? AND band_type = 'water' ORDER BY band_order", [tariff.id]),
    sanitationBands: all("SELECT * FROM water_tariff_bands WHERE tariff_set_id = ? AND band_type = 'sanitation' ORDER BY band_order", [tariff.id]),
    fixedCharges: all("SELECT * FROM fixed_charges WHERE tariff_set_id = ?", [tariff.id])
  });
});
router.put('/tariffs/:id', (req, res) => {
  const { name, effective_from, waterBands, sanitationBands, fixedCharges } = req.body; const id = +req.params.id;
  run("UPDATE tariff_sets SET name=?, effective_from=? WHERE id=?", [name, effective_from, id]);
  if (waterBands) { run("DELETE FROM water_tariff_bands WHERE tariff_set_id=? AND band_type='water'", [id]); waterBands.forEach((b, i) => run("INSERT INTO water_tariff_bands (tariff_set_id,band_type,band_order,from_kl,to_kl,rate_per_kl) VALUES (?,'water',?,?,?,?)", [id, i+1, b.from_kl, b.to_kl, b.rate_per_kl])); }
  if (sanitationBands) { run("DELETE FROM water_tariff_bands WHERE tariff_set_id=? AND band_type='sanitation'", [id]); sanitationBands.forEach((b, i) => run("INSERT INTO water_tariff_bands (tariff_set_id,band_type,band_order,from_kl,to_kl,rate_per_kl) VALUES (?,'sanitation',?,?,?,?)", [id, i+1, b.from_kl, b.to_kl, b.rate_per_kl])); }
  if (fixedCharges) { run("DELETE FROM fixed_charges WHERE tariff_set_id=?", [id]); fixedCharges.forEach(c => run("INSERT INTO fixed_charges (tariff_set_id,charge_type,description,amount_per_day,amount_fixed,split_by_units) VALUES (?,?,?,?,?,?)", [id, c.charge_type, c.description, c.amount_per_day, c.amount_fixed, c.split_by_units])); }
  res.json({ message: 'Tariff updated' });
});

router.get('/settings', (req, res) => { const obj = {}; all("SELECT * FROM settings").forEach(r => obj[r.key] = r.value); res.json(obj); });
router.put('/settings', (req, res) => {
  for (const [k, v] of Object.entries(req.body)) run("INSERT INTO settings (key,value,updated_at) VALUES (?,?,datetime('now')) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=datetime('now')", [k, String(v)]);
  res.json({ message: 'Settings updated' });
});

router.get('/billing-periods', (req, res) => res.json(all("SELECT * FROM billing_periods ORDER BY year DESC, month DESC")));
router.post('/billing-periods', (req, res) => {
  const { year, month, billing_month_label, previous_reading_date, current_reading_date } = req.body;
  const days = getDaysInMonth(year, month);
  if (get("SELECT id FROM billing_periods WHERE year=? AND month=?", [year, month])) return res.status(409).json({ error: 'Period already exists' });
  const r = run("INSERT INTO billing_periods (year,month,billing_month_label,days_in_month,previous_reading_date,current_reading_date) VALUES (?,?,?,?,?,?)", [year, month, billing_month_label, days, previous_reading_date||null, current_reading_date||null]);
  res.json({ id: r.lastInsertRowid, days_in_month: days, message: 'Created' });
});
router.put('/billing-periods/:id', (req, res) => {
  const c = get("SELECT * FROM billing_periods WHERE id=?", [+req.params.id]); if (!c) return res.status(404).json({ error: 'Not found' });
  const { billing_month_label, previous_reading_date, current_reading_date, status } = req.body;
  run("UPDATE billing_periods SET billing_month_label=?,previous_reading_date=?,current_reading_date=?,status=? WHERE id=?", [billing_month_label||c.billing_month_label, previous_reading_date||c.previous_reading_date, current_reading_date||c.current_reading_date, status||c.status, +req.params.id]);
  res.json({ message: 'Updated' });
});

router.get('/billing-periods/:periodId/readings', (req, res) => res.json(all("SELECT mr.*, t.name as tenant_name, t.unit_number FROM meter_readings mr JOIN tenants t ON mr.tenant_id = t.id WHERE mr.billing_period_id = ? ORDER BY t.unit_number", [+req.params.periodId])));
router.post('/meter-readings', (req, res) => {
  const { billing_period_id, tenant_id, meter_type, previous_reading, current_reading } = req.body;
  const usage_kl = (current_reading - previous_reading) / 1000;
  const existing = get("SELECT id FROM meter_readings WHERE billing_period_id=? AND tenant_id=? AND meter_type=?", [billing_period_id, tenant_id, meter_type]);
  if (existing) { run("UPDATE meter_readings SET previous_reading=?,current_reading=?,usage_kl=? WHERE id=?", [previous_reading, current_reading, usage_kl, existing.id]); res.json({ id: existing.id, usage_kl, message: 'Updated' }); }
  else { const r = run("INSERT INTO meter_readings (billing_period_id,tenant_id,meter_type,previous_reading,current_reading,usage_kl) VALUES (?,?,?,?,?,?)", [billing_period_id, tenant_id, meter_type, previous_reading, current_reading, usage_kl]); res.json({ id: r.lastInsertRowid, usage_kl, message: 'Saved' }); }
});
router.get('/meter-readings/last/:tenantId/:meterType', (req, res) => {
  const r = get("SELECT mr.* FROM meter_readings mr JOIN billing_periods bp ON mr.billing_period_id=bp.id WHERE mr.tenant_id=? AND mr.meter_type=? ORDER BY bp.year DESC,bp.month DESC LIMIT 1", [+req.params.tenantId, req.params.meterType]);
  res.json(r || null);
});

router.post('/generate-invoice/:periodId/:tenantId', (req, res) => {
  try {
    const lines = generateLineItems(+req.params.tenantId, +req.params.periodId);
    saveLineItems(+req.params.tenantId, +req.params.periodId, lines);
    const subtotal = lines.reduce((s, l) => s + l.amount, 0);
    const vatRate = parseFloat(get("SELECT value FROM settings WHERE key='vat_rate'")?.value || '15') / 100;
    res.json({ lines, subtotal, tax: subtotal * vatRate, total: subtotal * (1 + vatRate) });
  } catch (e) { res.status(400).json({ error: e.message }); }
});
router.get('/invoice-lines/:periodId/:tenantId', (req, res) => {
  const lines = all("SELECT * FROM invoice_line_items WHERE billing_period_id=? AND tenant_id=? ORDER BY line_order", [+req.params.periodId, +req.params.tenantId]);
  const subtotal = lines.reduce((s, l) => s + l.amount, 0);
  const vatRate = parseFloat(get("SELECT value FROM settings WHERE key='vat_rate'")?.value || '15') / 100;
  res.json({ lines, subtotal, tax: subtotal * vatRate, total: subtotal * (1 + vatRate) });
});
router.post('/generate-all/:periodId', (req, res) => {
  const tenants = all("SELECT * FROM tenants WHERE is_active=1 AND is_placeholder=0");
  const results = [];
  for (const t of tenants) {
    try {
      const lines = generateLineItems(t.id, +req.params.periodId);
      saveLineItems(t.id, +req.params.periodId, lines);
      const subtotal = lines.reduce((s, l) => s + l.amount, 0);
      const vatRate = parseFloat(get("SELECT value FROM settings WHERE key='vat_rate'")?.value || '15') / 100;
      results.push({ tenant_id: t.id, tenant_name: t.name, unit_number: t.unit_number, lines, subtotal, tax: subtotal * vatRate, total: subtotal * (1 + vatRate) });
    } catch (e) { results.push({ tenant_id: t.id, tenant_name: t.name, unit_number: t.unit_number, error: e.message }); }
  }
  res.json(results);
});
router.post('/calculate-water', (req, res) => {
  const { usage_kl, tariff_set_id } = req.body;
  const tsId = tariff_set_id || get("SELECT id FROM tariff_sets WHERE is_active=1 LIMIT 1")?.id;
  if (!tsId) return res.status(400).json({ error: 'No active tariff set' });
  res.json(calculateWaterBill(usage_kl, tsId));
});

module.exports = router;
