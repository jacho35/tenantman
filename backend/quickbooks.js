const { get, all, run } = require('./database');

// QuickBooks OAuth2 endpoints
const QBO_AUTH_URL = 'https://appcenter.intuit.com/connect/oauth2';
const QBO_TOKEN_URL = 'https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer';
const QBO_API_BASE = 'https://quickbooks.api.intuit.com/v3/company';
const QBO_SANDBOX_API_BASE = 'https://sandbox-quickbooks.api.intuit.com/v3/company';

function getConfig() {
  return get("SELECT * FROM qbo_config WHERE id = 1");
}

function getApiBase() {
  const useSandbox = get("SELECT value FROM settings WHERE key = 'qbo_use_sandbox'");
  return (useSandbox && useSandbox.value === '1') ? QBO_SANDBOX_API_BASE : QBO_API_BASE;
}

function getRedirectUri() {
  const setting = get("SELECT value FROM settings WHERE key = 'qbo_redirect_uri'");
  return (setting && setting.value) || 'http://localhost:3456/api/qbo/callback';
}

function buildAuthUrl() {
  const config = getConfig();
  if (!config || !config.client_id) throw new Error('QuickBooks client_id not configured');
  const params = new URLSearchParams({
    client_id: config.client_id,
    response_type: 'code',
    scope: 'com.intuit.quickbooks.accounting',
    redirect_uri: getRedirectUri(),
    state: 'tenantman_qbo_auth',
  });
  return `${QBO_AUTH_URL}?${params.toString()}`;
}

async function exchangeCodeForTokens(code, realmId) {
  const config = getConfig();
  if (!config || !config.client_id || !config.client_secret) {
    throw new Error('QuickBooks credentials not configured');
  }

  const credentials = Buffer.from(`${config.client_id}:${config.client_secret}`).toString('base64');
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: getRedirectUri(),
  });

  const res = await fetch(QBO_TOKEN_URL, {
    method: 'POST',
    headers: {
      'Authorization': `Basic ${credentials}`,
      'Content-Type': 'application/x-www-form-urlencoded',
      'Accept': 'application/json',
    },
    body: body.toString(),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Token exchange failed: ${err}`);
  }

  const tokens = await res.json();
  const now = new Date();
  const tokenExpires = new Date(now.getTime() + tokens.expires_in * 1000).toISOString();
  const refreshExpires = new Date(now.getTime() + tokens.x_refresh_token_expires_in * 1000).toISOString();

  run(`UPDATE qbo_config SET
    realm_id = ?, access_token = ?, refresh_token = ?,
    token_expires_at = ?, refresh_token_expires_at = ?,
    is_connected = 1, updated_at = datetime('now')
    WHERE id = 1`,
    [realmId, tokens.access_token, tokens.refresh_token, tokenExpires, refreshExpires]
  );

  return tokens;
}

async function refreshAccessToken() {
  const config = getConfig();
  if (!config || !config.refresh_token) throw new Error('No refresh token available');

  const credentials = Buffer.from(`${config.client_id}:${config.client_secret}`).toString('base64');
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: config.refresh_token,
  });

  const res = await fetch(QBO_TOKEN_URL, {
    method: 'POST',
    headers: {
      'Authorization': `Basic ${credentials}`,
      'Content-Type': 'application/x-www-form-urlencoded',
      'Accept': 'application/json',
    },
    body: body.toString(),
  });

  if (!res.ok) {
    const err = await res.text();
    // If refresh fails, mark as disconnected
    run("UPDATE qbo_config SET is_connected = 0, updated_at = datetime('now') WHERE id = 1");
    throw new Error(`Token refresh failed: ${err}`);
  }

  const tokens = await res.json();
  const now = new Date();
  const tokenExpires = new Date(now.getTime() + tokens.expires_in * 1000).toISOString();
  const refreshExpires = new Date(now.getTime() + tokens.x_refresh_token_expires_in * 1000).toISOString();

  run(`UPDATE qbo_config SET
    access_token = ?, refresh_token = ?,
    token_expires_at = ?, refresh_token_expires_at = ?,
    updated_at = datetime('now')
    WHERE id = 1`,
    [tokens.access_token, tokens.refresh_token, tokenExpires, refreshExpires]
  );

  return tokens.access_token;
}

async function getValidAccessToken() {
  const config = getConfig();
  if (!config || !config.is_connected) throw new Error('QuickBooks not connected');

  // Check if token is expired or will expire in the next 5 minutes
  const now = new Date();
  const expiresAt = new Date(config.token_expires_at);
  const bufferMs = 5 * 60 * 1000;

  if (now.getTime() + bufferMs >= expiresAt.getTime()) {
    return await refreshAccessToken();
  }

  return config.access_token;
}

async function qboRequest(method, endpoint, body = null) {
  const config = getConfig();
  const accessToken = await getValidAccessToken();
  const apiBase = getApiBase();
  const url = `${apiBase}/${config.realm_id}${endpoint}`;

  const opts = {
    method,
    headers: {
      'Authorization': `Bearer ${accessToken}`,
      'Accept': 'application/json',
      'Content-Type': 'application/json',
    },
  };

  if (body) opts.body = JSON.stringify(body);

  const res = await fetch(url, opts);
  const data = await res.json();

  if (!res.ok) {
    const errMsg = data?.Fault?.Error?.[0]?.Detail || data?.Fault?.Error?.[0]?.Message || JSON.stringify(data);
    throw new Error(`QBO API error: ${errMsg}`);
  }

  return data;
}

// Query QBO customers
async function queryCustomers() {
  const data = await qboRequest('GET', '/query?query=' + encodeURIComponent("SELECT * FROM Customer WHERE Active = true MAXRESULTS 1000"));
  return data.QueryResponse?.Customer || [];
}

// Find or create a QBO customer matching a tenant
async function findOrCreateCustomer(tenant) {
  // Check if tenant already has a QBO customer ID mapped
  const mapping = get("SELECT qbo_customer_id FROM tenants WHERE id = ?", [tenant.id]);
  if (mapping && mapping.qbo_customer_id) {
    // Verify customer still exists in QBO
    try {
      const data = await qboRequest('GET', `/customer/${mapping.qbo_customer_id}`);
      if (data.Customer) return data.Customer;
    } catch (e) {
      // Customer may have been deleted, fall through to search/create
    }
  }

  // Search by email
  if (tenant.email) {
    try {
      const data = await qboRequest('GET', '/query?query=' + encodeURIComponent(`SELECT * FROM Customer WHERE PrimaryEmailAddr = '${tenant.email}'`));
      const customers = data.QueryResponse?.Customer || [];
      if (customers.length > 0) {
        run("UPDATE tenants SET qbo_customer_id = ? WHERE id = ?", [customers[0].Id, tenant.id]);
        return customers[0];
      }
    } catch (e) {
      // Fall through to create
    }
  }

  // Search by display name
  try {
    const displayName = `Unit ${tenant.unit_number} - ${tenant.name}`;
    const data = await qboRequest('GET', '/query?query=' + encodeURIComponent(`SELECT * FROM Customer WHERE DisplayName = '${displayName}'`));
    const customers = data.QueryResponse?.Customer || [];
    if (customers.length > 0) {
      run("UPDATE tenants SET qbo_customer_id = ? WHERE id = ?", [customers[0].Id, tenant.id]);
      return customers[0];
    }
  } catch (e) {
    // Fall through to create
  }

  // Create new customer
  const customerData = {
    DisplayName: `Unit ${tenant.unit_number} - ${tenant.name}`,
    PrimaryEmailAddr: tenant.email ? { Address: tenant.email } : undefined,
    BillAddr: tenant.billing_address ? { Line1: tenant.billing_address } : undefined,
  };

  const result = await qboRequest('POST', '/customer', customerData);
  const customerId = result.Customer.Id;
  run("UPDATE tenants SET qbo_customer_id = ? WHERE id = ?", [customerId, tenant.id]);
  return result.Customer;
}

// Build a QBO invoice from local line items
function buildQboInvoice(customer, lineItems, period, tenant) {
  const vatRate = parseFloat(get("SELECT value FROM settings WHERE key = 'vat_rate'")?.value || '15');
  const settings_data = {};
  all("SELECT * FROM settings").forEach(r => settings_data[r.key] = r.value);

  const lines = lineItems.map((item, idx) => ({
    DetailType: 'SalesItemLineDetail',
    Amount: parseFloat(item.amount.toFixed(2)),
    Description: item.description.replace(/\n/g, ', '),
    SalesItemLineDetail: {
      UnitPrice: parseFloat(item.rate.toFixed(2)),
      Qty: item.qty,
    },
  }));

  const invoice = {
    CustomerRef: { value: customer.Id },
    Line: lines,
    TxnDate: period.current_reading_date || new Date().toISOString().split('T')[0],
    PrivateNote: `Tenantman - ${period.billing_month_label} - Unit ${tenant.unit_number}`,
    CustomerMemo: { value: `Invoice for ${period.billing_month_label}` },
  };

  return invoice;
}

// Push a single invoice to QBO
async function pushInvoice(tenantId, billingPeriodId) {
  const tenant = get("SELECT * FROM tenants WHERE id = ?", [tenantId]);
  const period = get("SELECT * FROM billing_periods WHERE id = ?", [billingPeriodId]);
  if (!tenant || !period) throw new Error('Tenant or billing period not found');

  const lineItems = all("SELECT * FROM invoice_line_items WHERE billing_period_id = ? AND tenant_id = ? ORDER BY line_order", [billingPeriodId, tenantId]);
  if (!lineItems.length) throw new Error('No invoice line items found. Generate the invoice first.');

  // Check if already pushed
  const existing = get("SELECT * FROM qbo_invoice_push WHERE billing_period_id = ? AND tenant_id = ?", [billingPeriodId, tenantId]);
  if (existing && existing.status === 'pushed') {
    throw new Error(`Invoice already pushed to QuickBooks (QBO Invoice #${existing.qbo_invoice_id})`);
  }

  // Find or create QBO customer
  const customer = await findOrCreateCustomer(tenant);

  // Build and push invoice
  const qboInvoice = buildQboInvoice(customer, lineItems, period, tenant);
  const result = await qboRequest('POST', '/invoice', qboInvoice);

  const qboInvoiceId = result.Invoice.Id;
  const qboDocNumber = result.Invoice.DocNumber || '';

  // Record push status
  if (existing) {
    run(`UPDATE qbo_invoice_push SET
      qbo_invoice_id = ?, qbo_doc_number = ?, status = 'pushed',
      pushed_at = datetime('now'), error_message = NULL
      WHERE id = ?`, [qboInvoiceId, qboDocNumber, existing.id]);
  } else {
    run(`INSERT INTO qbo_invoice_push (billing_period_id, tenant_id, qbo_invoice_id, qbo_doc_number, status, pushed_at)
      VALUES (?, ?, ?, ?, 'pushed', datetime('now'))`, [billingPeriodId, tenantId, qboInvoiceId, qboDocNumber]);
  }

  return { qbo_invoice_id: qboInvoiceId, doc_number: qboDocNumber };
}

// Disconnect from QBO
function disconnect() {
  run(`UPDATE qbo_config SET
    access_token = NULL, refresh_token = NULL,
    token_expires_at = NULL, refresh_token_expires_at = NULL,
    realm_id = NULL, is_connected = 0, updated_at = datetime('now')
    WHERE id = 1`);
}

module.exports = {
  getConfig,
  buildAuthUrl,
  exchangeCodeForTokens,
  refreshAccessToken,
  getValidAccessToken,
  queryCustomers,
  findOrCreateCustomer,
  pushInvoice,
  disconnect,
};
