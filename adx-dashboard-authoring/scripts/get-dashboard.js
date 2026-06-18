#!/usr/bin/env node
'use strict';

/*
 * Read a single ADX dashboard by ID via the (unofficial) Dashboard management API.
 * Read-only: this skill never writes through the API. Apply changes with the
 * adx-dashboard-live-edit skill (browser path) instead.
 */

const { DefaultAzureCredential } = require('@azure/identity');

const API_BASE = 'https://dashboards.kusto.windows.net';
const SCOPE = 'https://rtd-metadata.azurewebsites.net/.default';

async function getDashboard(dashboardId) {
  const credential = new DefaultAzureCredential();
  const token = await credential.getToken(SCOPE);

  const res = await fetch(`${API_BASE}/dashboards/${dashboardId}`, {
    headers: {
      Authorization: `Bearer ${token.token}`,
      Accept: 'application/json',
    },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    const err = new Error(`HTTP ${res.status} fetching dashboard ${dashboardId}: ${body}`);
    err.status = res.status;
    throw err;
  }

  const data = await res.json();
  // Capture the eTag so an eventual write path can do optimistic concurrency.
  const etag = res.headers.get('etag');
  if (etag) data._metadata = { eTag: etag };
  return data;
}

async function main() {
  const id = process.argv[2];
  if (!id) {
    process.stderr.write('Usage: get-dashboard.js <dashboard_id>\n');
    process.exit(2);
  }
  try {
    const dashboard = await getDashboard(id);
    process.stdout.write(JSON.stringify(dashboard, null, 2) + '\n');
  } catch (e) {
    process.stderr.write(JSON.stringify({ error: e.message, status: e.status }) + '\n');
    process.exit(1);
  }
}

module.exports = { getDashboard };

if (require.main === module) {
  main();
}
