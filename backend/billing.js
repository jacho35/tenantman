const { get, all, run } = require('./database');

function calculateSteppedTariff(usageKl, bands) {
  let remaining = usageKl;
  let totalCost = 0;
  const breakdown = [];
  for (const band of bands) {
    if (remaining <= 0) break;
    const bandWidth = band.to_kl - band.from_kl;
    const usedInBand = Math.min(remaining, bandWidth);
    const cost = usedInBand * band.rate_per_kl;
    totalCost += cost;
    breakdown.push({ from: band.from_kl, to: band.to_kl, rate: band.rate_per_kl, used: usedInBand, cost });
    remaining -= usedInBand;
  }
  return { totalCost, breakdown };
}

function calculateWaterBill(usageKl, tariffSetId) {
  const waterBands = all("SELECT * FROM water_tariff_bands WHERE tariff_set_id = ? AND band_type = 'water' ORDER BY band_order", [tariffSetId]);
  const sanitationBands = all("SELECT * FROM water_tariff_bands WHERE tariff_set_id = ? AND band_type = 'sanitation' ORDER BY band_order", [tariffSetId]);
  // CoCT convention: sanitation is calculated on 90% of water usage
  const sanFactor = parseFloat(get("SELECT value FROM settings WHERE key = 'sanitation_factor'")?.value || '0.9');
  const sanUsage = usageKl * sanFactor;
  const water = calculateSteppedTariff(usageKl, waterBands);
  const sanitation = calculateSteppedTariff(sanUsage, sanitationBands);
  return { usageKl, sanitationUsageKl: sanUsage, waterCost: water.totalCost, sanitationCost: sanitation.totalCost, totalCost: water.totalCost + sanitation.totalCost, waterBreakdown: water.breakdown, sanitationBreakdown: sanitation.breakdown };
}

function generateLineItems(tenantId, billingPeriodId) {
  const tenant = get("SELECT * FROM tenants WHERE id = ?", [tenantId]);
  const period = get("SELECT * FROM billing_periods WHERE id = ?", [billingPeriodId]);
  if (!tenant || !period) throw new Error('Tenant or billing period not found');
  const activeTariff = get("SELECT * FROM tariff_sets WHERE is_active = 1 ORDER BY effective_from DESC LIMIT 1");
  if (!activeTariff) throw new Error('No active tariff set found');
  const fixedCharges = all("SELECT * FROM fixed_charges WHERE tariff_set_id = ?", [activeTariff.id]);
  const propertyAddress = get("SELECT value FROM settings WHERE key = 'property_address'")?.value || '35 Stillewater Street';
  const lines = [];
  let order = 1;

  // Compute utility month label with per-tenant offset (0 = current month, 1 = next month)
  const MONTH_SHORT = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const offset = tenant.utility_month_offset || 0;
  let utilMonth = period.month - 1 + offset; // 0-based
  let utilYear = period.year;
  if (utilMonth > 11) { utilMonth -= 12; utilYear++; }
  const utilLabel = `${MONTH_SHORT[utilMonth]} ${utilYear}`;

  if (tenant.rental_amount > 0 && !tenant.is_placeholder) {
    lines.push({ line_order: order++, activity: '35 Stillewater Rental', description: `${propertyAddress} - Unit ${tenant.unit_number} Rental ${period.billing_month_label}`, tax_type: 'Standard', qty: 1, rate: tenant.rental_amount, amount: tenant.rental_amount });
  }

  const waterFixed = fixedCharges.find(c => c.charge_type === 'water_fixed');
  if (waterFixed) lines.push({ line_order: order++, activity: 'Utilities Income', description: `Water Fixed Charge - ${utilLabel}`, tax_type: 'Standard', qty: 1, rate: waterFixed.amount_fixed, amount: waterFixed.amount_fixed });

  const refuse = fixedCharges.find(c => c.charge_type === 'refuse');
  if (refuse) lines.push({ line_order: order++, activity: 'Utilities Income', description: `Refuse Collection Fixed Charge - ${utilLabel}`, tax_type: 'Standard', qty: 1, rate: refuse.amount_fixed, amount: refuse.amount_fixed });

  const waterReading = get("SELECT * FROM meter_readings WHERE billing_period_id = ? AND tenant_id = ? AND meter_type = 'water'", [billingPeriodId, tenantId]);
  if (waterReading) {
    const waterBill = calculateWaterBill(waterReading.usage_kl, activeTariff.id);
    const waterDesc = `Date of Previous Reading ${period.previous_reading_date || ''}\nDate of Current Reading ${period.current_reading_date || ''}\nPrevious Meter Reading ${waterReading.previous_reading}\nCurrent Meter Reading ${waterReading.current_reading}\nkl ${waterReading.usage_kl.toFixed(3)}\nR${waterBill.totalCost.toFixed(2)}`;
    lines.push({ line_order: order++, activity: 'Utilities Income', description: waterDesc, tax_type: 'Standard', qty: 1, rate: parseFloat(waterBill.totalCost.toFixed(2)), amount: parseFloat(waterBill.totalCost.toFixed(2)) });
    run("UPDATE meter_readings SET calculated_amount = ? WHERE id = ?", [waterBill.totalCost, waterReading.id]);
  }

  for (const eskomType of ['eskom_service', 'eskom_network', 'eskom_generation']) {
    const charge = fixedCharges.find(c => c.charge_type === eskomType);
    if (charge) {
      const perUnit = charge.amount_per_day / charge.split_by_units;
      const perUnitRounded = parseFloat(perUnit.toFixed(7));
      const totalAmount = parseFloat((perUnit * period.days_in_month).toFixed(2));
      lines.push({ line_order: order++, activity: 'Utilities Income', description: `${charge.description} / ${charge.split_by_units} units - ${utilLabel}`, tax_type: 'Standard', qty: period.days_in_month, rate: perUnitRounded, amount: totalAmount });
    }
  }

  if (tenant.has_electricity) {
    const elecReading = get("SELECT * FROM meter_readings WHERE billing_period_id = ? AND tenant_id = ? AND meter_type = 'electricity'", [billingPeriodId, tenantId]);
    if (elecReading && elecReading.calculated_amount) {
      lines.push({ line_order: order++, activity: 'Utilities Income', description: `Electricity Units Used ${elecReading.usage_kl}kWh - ${utilLabel}`, tax_type: 'Standard', qty: elecReading.usage_kl, rate: elecReading.calculated_amount / elecReading.usage_kl, amount: elecReading.calculated_amount });
    }
  }

  if (tenant.has_internet) {
    lines.push({ line_order: order++, activity: 'Utilities Income', description: 'Internet', tax_type: 'Standard', qty: 1, rate: tenant.internet_amount, amount: tenant.internet_amount });
  }

  return lines;
}

function saveLineItems(tenantId, billingPeriodId, lines) {
  run("DELETE FROM invoice_line_items WHERE billing_period_id = ? AND tenant_id = ?", [billingPeriodId, tenantId]);
  for (const item of lines) {
    run("INSERT INTO invoice_line_items (billing_period_id,tenant_id,line_order,activity,description,tax_type,qty,rate,amount) VALUES (?,?,?,?,?,?,?,?,?)",
      [billingPeriodId, tenantId, item.line_order, item.activity, item.description, item.tax_type, item.qty, item.rate, item.amount]);
  }
  return lines;
}

function getDaysInMonth(year, month) { return new Date(year, month, 0).getDate(); }

module.exports = { calculateWaterBill, generateLineItems, saveLineItems, getDaysInMonth, calculateSteppedTariff };
