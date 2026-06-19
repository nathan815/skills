#!/usr/bin/env node
'use strict';

/*
 * List ADX dashboards accessible to the signed-in user via the Dashboard management API.
 * Read-only. Requires an Azure login that DefaultAzureCredential can use (e.g. `az login`).
 */

const { DefaultAzureCredential } = require('@azure/identity');

const API_BASE = 'https://dashboards.kusto.windows.net';
const SCOPE = 'https://rtd-metadata.azurewebsites.net/.default';

async function listDashboards() {
  const credential = new DefaultAzureCredential();
  const token = await credential.getToken(SCOPE);

  const res = await fetch(`${API_BASE}/api/dashboards`, {
    headers: {
      Authorization: `Bearer ${token.token}`,
      Accept: 'application/json',
    },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    const err = new Error(`HTTP ${res.status} listing dashboards: ${body}`);
    err.status = res.status;
    throw err;
  }
  return res.json();
}

async function main() {
  try {
    const dashboards = await listDashboards();
    process.stdout.write(JSON.stringify(dashboards, null, 2) + '\n');
  } catch (e) {
    process.stderr.write(JSON.stringify({ error: e.message, status: e.status }) + '\n');
    process.exit(1);
  }
}

module.exports = { listDashboards };

if (require.main === module) {
  main();
}
