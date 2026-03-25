const express = require('express');
const { get, all, run } = require('./database');
const qbo = require('./quickbooks');
const router = express.Router();

// GET /api/qbo/status - Connection status
router.get('/status', (req, res) => {
  const config = qbo.getConfig();
  res.json({
    is_connected: !!config?.is_connected,
    realm_id: config?.realm_id || null,
    has_credentials: !!(config?.client_id && config?.client_secret),
    token_expires_at: config?.token_expires_at || null,
    refresh_token_expires_at: config?.refresh_token_expires_at || null,
  });
});

// GET /api/qbo/config - Get config (without secrets)
router.get('/config', (req, res) => {
  const config = qbo.getConfig();
  const useSandbox = get("SELECT value FROM settings WHERE key = 'qbo_use_sandbox'");
  const redirectUri = get("SELECT value FROM settings WHERE key = 'qbo_redirect_uri'");
  res.json({
    client_id: config?.client_id || '',
    has_secret: !!config?.client_secret,
    realm_id: config?.realm_id || '',
    is_connected: !!config?.is_connected,
    use_sandbox: useSandbox?.value === '1',
    redirect_uri: redirectUri?.value || 'http://localhost:3456/api/qbo/callback',
  });
});

// PUT /api/qbo/config - Update client credentials
router.put('/config', (req, res) => {
  const { client_id, client_secret, use_sandbox, redirect_uri } = req.body;
  if (client_id !== undefined) {
    run("UPDATE qbo_config SET client_id = ?, updated_at = datetime('now') WHERE id = 1", [client_id]);
  }
  if (client_secret !== undefined && client_secret !== '') {
    run("UPDATE qbo_config SET client_secret = ?, updated_at = datetime('now') WHERE id = 1", [client_secret]);
  }
  if (use_sandbox !== undefined) {
    run("INSERT INTO settings (key, value, updated_at) VALUES ('qbo_use_sandbox', ?, datetime('now')) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=datetime('now')", [use_sandbox ? '1' : '0']);
  }
  if (redirect_uri !== undefined) {
    run("INSERT INTO settings (key, value, updated_at) VALUES ('qbo_redirect_uri', ?, datetime('now')) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=datetime('now')", [redirect_uri]);
  }
  res.json({ message: 'QuickBooks config updated' });
});

// GET /api/qbo/auth-url - Generate OAuth2 authorization URL
router.get('/auth-url', (req, res) => {
  try {
    const url = qbo.buildAuthUrl();
    res.json({ url });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// GET /api/qbo/callback - OAuth2 callback handler
router.get('/callback', async (req, res) => {
  const { code, realmId, state, error } = req.query;
  console.log('[QBO Callback] Received:', { code: code ? 'present' : 'missing', realmId, state, error: error || 'none' });

  if (error) {
    console.error('[QBO Callback] Auth error from Intuit:', error);
    return res.send(callbackPage(false, `Authorization denied: ${error}`));
  }
  if (!code || !realmId) {
    console.error('[QBO Callback] Missing code or realmId');
    return res.status(400).send(callbackPage(false, 'Missing authorization code or realm ID'));
  }
  try {
    await qbo.exchangeCodeForTokens(code, realmId);
    console.log('[QBO Callback] Token exchange successful, realm:', realmId);
    res.send(callbackPage(true, 'Connected to QuickBooks!'));
  } catch (e) {
    console.error('[QBO Callback] Token exchange failed:', e.message);
    res.status(500).send(callbackPage(false, e.message));
  }
});

function callbackPage(success, message) {
  const color = success ? '#00e676' : '#ff5252';
  const title = success ? 'Connected to QuickBooks!' : 'Connection Failed';
  // Try postMessage to opener (popup flow), then redirect to settings (same-tab flow)
  return `<!DOCTYPE html><html><head><meta charset="UTF-8"><title>QuickBooks ${success ? 'Connected' : 'Error'}</title></head>
<body style="font-family:sans-serif;background:#0f1119;color:#e8eaf6;display:flex;align-items:center;justify-content:center;height:100vh;margin:0">
<div style="text-align:center;max-width:500px;padding:20px">
  <h2 style="color:${color}">${title}</h2>
  <p style="color:#9fa8da">${message}</p>
  <p style="color:#5c6bc0;font-size:13px;margin-top:20px" id="redirect-msg"></p>
</div>
<script>
  var sent = false;
  try {
    if (window.opener && !window.opener.closed) {
      window.opener.postMessage({type:'qbo_auth',success:${success},error:${JSON.stringify(success ? '' : message)}},'*');
      sent = true;
      document.getElementById('redirect-msg').textContent = 'You can close this window.';
      ${success ? "setTimeout(function(){window.close()},2000);" : ""}
    }
  } catch(e) {}
  if (!sent) {
    document.getElementById('redirect-msg').textContent = 'Redirecting back to settings...';
    setTimeout(function(){ window.location.href = '/#settings'; },${success ? 2000 : 5000});
  }
</script>
</body></html>`;
}

// POST /api/qbo/disconnect - Disconnect from QBO
router.post('/disconnect', (req, res) => {
  qbo.disconnect();
  res.json({ message: 'Disconnected from QuickBooks' });
});

// GET /api/qbo/customers - List QBO customers
router.get('/customers', async (req, res) => {
  try {
    const customers = await qbo.queryCustomers();
    res.json(customers);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/qbo/push-invoice/:periodId/:tenantId - Push single invoice
router.post('/push-invoice/:periodId/:tenantId', async (req, res) => {
  try {
    const result = await qbo.pushInvoice(+req.params.tenantId, +req.params.periodId);
    res.json({ message: 'Invoice pushed to QuickBooks', ...result });
  } catch (e) {
    // Record failure
    const existing = get("SELECT * FROM qbo_invoice_push WHERE billing_period_id = ? AND tenant_id = ?",
      [+req.params.periodId, +req.params.tenantId]);
    if (existing) {
      run("UPDATE qbo_invoice_push SET status = 'failed', error_message = ?, pushed_at = datetime('now') WHERE id = ?",
        [e.message, existing.id]);
    } else {
      run("INSERT INTO qbo_invoice_push (billing_period_id, tenant_id, status, error_message, pushed_at) VALUES (?, ?, 'failed', ?, datetime('now'))",
        [+req.params.periodId, +req.params.tenantId, e.message]);
    }
    res.status(500).json({ error: e.message });
  }
});

// POST /api/qbo/push-all/:periodId - Push all invoices for a period
router.post('/push-all/:periodId', async (req, res) => {
  const periodId = +req.params.periodId;
  const tenants = all("SELECT * FROM tenants WHERE is_active = 1 AND is_placeholder = 0");
  const results = [];

  for (const tenant of tenants) {
    try {
      const result = await qbo.pushInvoice(tenant.id, periodId);
      results.push({ tenant_id: tenant.id, tenant_name: tenant.name, unit_number: tenant.unit_number, status: 'pushed', ...result });
    } catch (e) {
      results.push({ tenant_id: tenant.id, tenant_name: tenant.name, unit_number: tenant.unit_number, status: 'failed', error: e.message });
    }
  }

  res.json(results);
});

// GET /api/qbo/push-status/:periodId - Get push status for all tenants in a period
router.get('/push-status/:periodId', (req, res) => {
  const statuses = all(`SELECT qip.*, t.name as tenant_name, t.unit_number
    FROM qbo_invoice_push qip
    JOIN tenants t ON qip.tenant_id = t.id
    WHERE qip.billing_period_id = ?
    ORDER BY t.unit_number`, [+req.params.periodId]);
  res.json(statuses);
});

module.exports = router;
