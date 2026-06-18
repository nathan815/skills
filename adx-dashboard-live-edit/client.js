#!/usr/bin/env node
'use strict';

/*
 * adx-live-edit: the single blessed entry point for applying live changes to an
 * open ADX dashboard through the browser extension.
 *
 * Why this exists: when the agent is handed raw HTTP endpoints it improvises
 * (e.g. falling back to a management-API write that forces a full page reload).
 * This CLI wraps the localhost daemon, guarantees the daemon is running, and
 * validates a dashboard against the official schema before it is ever sent to
 * the browser. Every failure is reported as structured JSON so the agent has a
 * clear signal instead of a silent hang to work around.
 */

const fs = require('fs');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');
const { validateDashboard } = require('./validate.js');

const PORT = parseInt(process.env.ADX_AGENT_PORT || '9876', 10);
const BASE = `http://127.0.0.1:${PORT}`;
const SERVER_PATH = path.join(__dirname, 'chrome-extension', 'agent-server.js');
const LOG_DIR = path.join(__dirname, '.cache');
const LOG_PATH = path.join(LOG_DIR, 'agent-server.log');

// Print a structured result to stdout and exit. The agent consumes stdout as
// JSON, so we never mix prose into it.
function emit(obj, code = 0) {
  process.stdout.write(JSON.stringify(obj, null, 2) + '\n');
  process.exit(code);
}

function fail(error, extra = {}) {
  process.stdout.write(JSON.stringify({ ok: false, error, ...extra }, null, 2) + '\n');
  process.exit(1);
}

// Use the built-in http module rather than global fetch. fetch (undici) keeps
// pooled sockets alive, and calling process.exit() while those are open crashes
// with a libuv assertion on Windows. http.request gives us clean, prompt exits
// for this localhost-only client.
function fetchJson(url, options = {}, timeoutMs = 130000) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = http.request(
      {
        hostname: u.hostname,
        port: u.port,
        path: u.pathname + u.search,
        method: options.method || 'GET',
        headers: options.headers || {},
      },
      (res) => {
        let data = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => {
          let body = null;
          if (data) {
            try { body = JSON.parse(data); } catch (e) { body = { raw: data }; }
          }
          resolve({ status: res.statusCode, ok: res.statusCode >= 200 && res.statusCode < 300, body });
        });
      }
    );
    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error(`Request timed out after ${timeoutMs}ms`));
    });
    req.on('error', reject);
    if (options.body) req.write(options.body);
    req.end();
  });
}

// Quick, short-timeout probe used for daemon health. A down daemon rejects fast
// (ECONNREFUSED) so this resolves quickly in the common start-up case.
async function isDaemonUp() {
  try {
    const res = await fetchJson(`${BASE}/status`, {}, 1000);
    return res.ok && res.body && res.body.status === 'ok';
  } catch (e) {
    return false;
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// Start the daemon as a detached, unref'd singleton. The daemon binds the port,
// so if one is already running a second spawn simply fails to bind and exits;
// we only spawn after a failed health probe, then wait for it to come up.
async function ensureDaemon() {
  if (await isDaemonUp()) return;

  if (!fs.existsSync(SERVER_PATH)) {
    fail(`Daemon not found at ${SERVER_PATH}`, { hint: 'Reinstall the skill so chrome-extension/agent-server.js is present.' });
  }

  fs.mkdirSync(LOG_DIR, { recursive: true });
  const out = fs.openSync(LOG_PATH, 'a');

  const child = spawn(process.execPath, [SERVER_PATH, '--port', String(PORT)], {
    detached: true,
    stdio: ['ignore', out, out],
    windowsHide: true,
  });
  child.unref();

  // Cold daemon start can be slow on the first run (Windows process spawn +
  // ajv lazy-load), so give it a generous window before declaring failure.
  // Still far below the request timeout, so this never masks a real hang.
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    await sleep(150);
    if (await isDaemonUp()) return;
  }

  fail('Daemon did not become healthy after start', { logPath: LOG_PATH });
}

function parseArgs(rest) {
  const positionals = [];
  const flags = {};
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = rest[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        flags[key] = next;
        i++;
      } else {
        flags[key] = true;
      }
    } else {
      positionals.push(a);
    }
  }
  return { positionals, flags };
}

function requireId(id) {
  if (!id) fail('Missing <dashboardId>', { hint: 'Run `adx-live-edit list` to see connected dashboards.' });
  return id;
}

// Treat any non-2xx response, or a relayed extension failure, as an error so the
// agent gets one consistent failure signal instead of a misleading success.
// Some extension actions report problems as { error } with a 200 status (e.g.
// page-not-found), so a top-level error is a failure even when HTTP says OK.
function expectOk(res, context) {
  if (!res.ok) {
    fail(`${context} failed (HTTP ${res.status})`, { response: res.body });
  }
  if (res.body && res.body.success === false) {
    fail(`${context} failed`, { response: res.body });
  }
  if (res.body && res.body.error) {
    fail(`${context} failed`, { response: res.body });
  }
  return res.body;
}

const HELP = `adx-live-edit - apply live changes to an open ADX dashboard via the browser extension

Usage:
  adx-live-edit list                          List dashboards currently connected via the extension
  adx-live-edit get <id>                      Print the live dashboard JSON
  adx-live-edit pages <id>                    List pages/tabs
  adx-live-edit select-page <id> <pageIdOrName>   Navigate to a page/tab
  adx-live-edit edit <id> <file.json>         Validate then apply a dashboard JSON file
  adx-live-edit refresh <id>                  Refresh the dashboard
  adx-live-edit errors <id>                   Report tile errors
  adx-live-edit status                        Daemon health

Edit options:
  --no-auto-confirm   Leave ADX's confirm dialog open instead of auto-confirming

Validation is always on. In the rare case ADX's published schema is wrong, set
ADX_SKIP_VALIDATION=1 in the environment to bypass it (applies to both this CLI
and the daemon).

The daemon (chrome-extension/agent-server.js) is started automatically on first use
and runs detached as a localhost singleton on port ${PORT}.

Authoring/validating dashboard JSON is the job of the adx-dashboard-authoring skill;
pull the schema and edit there, then apply with this command.
`;

async function cmdEdit(id, flags) {
  const file = flags._file;
  if (!file) fail('Missing <file.json>', { hint: 'adx-live-edit edit <id> <file.json>' });
  if (!fs.existsSync(file)) fail(`File not found: ${file}`);

  let dashboard;
  try {
    dashboard = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    fail(`Invalid JSON in ${file}: ${e.message}`);
  }

  // Strip metadata we add on read (eTag etc.) so it never reaches the schema
  // validator or the browser.
  if (dashboard && typeof dashboard === 'object') {
    for (const k of Object.keys(dashboard)) {
      if (k.startsWith('_')) delete dashboard[k];
    }
  }

  // Validate before sending. A bad edit must never reach the browser; this is
  // the fast-fail safety net even though authoring should have validated already
  // and the daemon re-validates as the authoritative gate. The same env hatch
  // the daemon honors disables it here so the whole path can be bypassed at once.
  if (process.env.ADX_SKIP_VALIDATION !== '1') {
    let result;
    try {
      result = await validateDashboard(dashboard);
    } catch (e) {
      fail(`Validation could not run: ${e.message}`, { hint: 'Check network access to the ADX schema host or a populated .cache/schema dir.' });
    }
    if (!result.valid) {
      fail('Dashboard failed schema validation; edit not applied', {
        validationErrors: result.errors,
        hint: 'Fix the JSON in the authoring skill and re-validate before applying.',
      });
    }
  }

  const autoConfirm = !flags['no-auto-confirm'];
  const res = await fetchJson(`${BASE}/dashboards/${encodeURIComponent(id)}/edit`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      dashboard,
      skipConfirmation: autoConfirm,
      filename: path.basename(file),
    }),
  });
  const body = res.body;
  // The extension reports "user must approve" as a distinct, recoverable state.
  // Surface it as its own signal (not a generic failure) so the agent knows to
  // ask the user to click "Allow Edits" and then simply re-run the same edit,
  // rather than improvising an alternate write path.
  if (body && body.pendingAuthorization) {
    emit({
      ok: false,
      pendingAuthorization: true,
      error: body.error || 'Authorization required in the ADX browser tab.',
      hint: "Tell the user to click 'Allow Edits' in the ADX dashboard tab, then re-run this exact edit command.",
    }, 2);
  }
  expectOk(res, 'Edit');
  emit({ ok: true, ...body });
}

async function main() {
  const command = process.argv[2];
  const { positionals, flags } = parseArgs(process.argv.slice(3));

  if (!command || command === 'help' || command === '--help' || command === '-h') {
    process.stdout.write(HELP);
    process.exit(0);
  }

  await ensureDaemon();

  switch (command) {
    case 'status': {
      const res = await fetchJson(`${BASE}/status`, {}, 2000);
      emit({ ok: true, ...expectOk(res, 'Status') });
      break;
    }
    case 'list': {
      const res = await fetchJson(`${BASE}/dashboards`, {}, 5000);
      emit({ ok: true, ...expectOk(res, 'List') });
      break;
    }
    case 'get': {
      const id = requireId(positionals[0]);
      const res = await fetchJson(`${BASE}/dashboards/${encodeURIComponent(id)}`);
      emit({ ok: true, dashboard: expectOk(res, 'Get') });
      break;
    }
    case 'pages': {
      const id = requireId(positionals[0]);
      const res = await fetchJson(`${BASE}/dashboards/${encodeURIComponent(id)}/pages`);
      emit({ ok: true, ...expectOk(res, 'Pages') });
      break;
    }
    case 'select-page': {
      const id = requireId(positionals[0]);
      const pageIdOrName = positionals[1];
      if (!pageIdOrName) fail('Missing <pageIdOrName>');
      const res = await fetchJson(`${BASE}/dashboards/${encodeURIComponent(id)}/selectPage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pageName: pageIdOrName }),
      });
      emit({ ok: true, ...expectOk(res, 'Select page') });
      break;
    }
    case 'edit': {
      const id = requireId(positionals[0]);
      flags._file = positionals[1];
      await cmdEdit(id, flags);
      break;
    }
    case 'refresh': {
      const id = requireId(positionals[0]);
      const res = await fetchJson(`${BASE}/dashboards/${encodeURIComponent(id)}/refresh`, { method: 'POST' });
      emit({ ok: true, ...expectOk(res, 'Refresh') });
      break;
    }
    case 'errors': {
      const id = requireId(positionals[0]);
      const res = await fetchJson(`${BASE}/dashboards/${encodeURIComponent(id)}/errors`);
      emit({ ok: true, ...expectOk(res, 'Errors') });
      break;
    }
    default:
      fail(`Unknown command: ${command}`, { hint: 'Run `adx-live-edit help`.' });
  }
}

main().catch((e) => {
  fail(e.message || String(e));
});
