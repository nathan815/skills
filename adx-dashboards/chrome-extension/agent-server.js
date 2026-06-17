#!/usr/bin/env node
/**
 * ADX Dashboard Agent Server (Node.js - Zero Dependencies)
 * 
 * A simple HTTP server that bridges between AI agents and the Chrome extension.
 * Uses long polling for instant response without WebSocket dependencies.
 * 
 * Usage:
 *     node agent-server.js [--port 9876]
 * 
 * API:
 *     POST /edit      - Submit dashboard edit (blocks until complete)
 *     GET  /dashboard - Get current dashboard JSON (blocks until received)
 *     GET  /poll      - Extension long-polls for commands
 *     POST /result    - Extension reports results
 *     GET  /status    - Health check
 */

const http = require('http');
const { randomUUID } = require('crypto');

const PORT = parseInt(process.argv.find((_, i, a) => a[i-1] === '--port') || '9876');
const EDIT_TIMEOUT_MS = 120000;
const GET_TIMEOUT_MS = 10000;
const ACTION_TIMEOUT_MS = 10000;
const POLL_TIMEOUT_MS = 30000;

// In-memory stores
const pendingEdits = new Map();
const pendingGets = new Map();
const pendingActions = new Map();  // Generic actions (getPages, selectPage, etc.)
const waitingPollers = [];  // Extension's long-poll requests
const connectedDashboards = new Map();  // id -> {id, title, connectedAt}

function log(msg) {
  const time = new Date().toLocaleTimeString('en-US', { hour12: false });
  console.log(`[${time}] ${msg}`);
}

// Wake up any waiting pollers when a new command arrives
function notifyPollers() {
  while (waitingPollers.length > 0) {
    const { res, dashboardId, timeout } = waitingPollers.shift();
    clearTimeout(timeout);
    handlePollResponse(res, dashboardId);
  }
}

function handlePollResponse(res, dashboardId) {
  // Check for pending get requests first
  for (const [id, get] of pendingGets) {
    if (!get.result && (get.dashboardId === '*' || get.dashboardId === dashboardId)) {
      sendJson(res, { pendingGet: { id, dashboardId: get.dashboardId } });
      return;
    }
  }

  // Check for pending actions (getPages, selectPage, etc.)
  for (const [id, action] of pendingActions) {
    if (!action.result && (action.dashboardId === '*' || action.dashboardId === dashboardId)) {
      sendJson(res, {
        pendingAction: {
          id,
          dashboardId: action.dashboardId,
          type: action.type,
          params: action.params
        }
      });
      return;
    }
  }

  // Check for pending edits
  for (const [id, edit] of pendingEdits) {
    if (!edit.result && (edit.dashboardId === '*' || edit.dashboardId === dashboardId)) {
      sendJson(res, {
        pendingEdit: {
          id,
          dashboardId: edit.dashboardId,
          dashboard: edit.dashboard,
          description: edit.description,
          skipConfirmation: edit.skipConfirmation,
          filename: edit.filename
        }
      });
      return;
    }
  }

  sendJson(res, { pendingEdit: null, pendingGet: null, pendingAction: null });
}

function sendJson(res, data, status = 200) {
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*'
  });
  res.end(JSON.stringify(data));
}

function parseBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (e) {
        reject(new Error('Invalid JSON'));
      }
    });
  });
}

// Route handlers
async function handleStatus(req, res) {
  sendJson(res, {
    status: 'ok',
    version: '2.0.0',
    pendingEdits: pendingEdits.size,
    pendingGets: pendingGets.size
  });
}

async function handleEdit(req, res) {
  let data;
  try {
    data = await parseBody(req);
  } catch (e) {
    return sendJson(res, { error: 'Invalid JSON' }, 400);
  }

  if (!data.dashboard) {
    return sendJson(res, { error: 'Missing dashboard field' }, 400);
  }

  const editId = randomUUID();
  const dashboardId = data.dashboardId || '*';

  const edit = {
    id: editId,
    dashboardId,
    dashboard: data.dashboard,
    description: data.description || 'Agent edit',
    skipConfirmation: data.skipConfirmation || false,
    filename: data.filename || 'agent-edit.json',
    createdAt: Date.now(),
    result: null,
    resolve: null
  };

  // Create promise that will be resolved when result arrives
  const resultPromise = new Promise((resolve) => {
    edit.resolve = resolve;
  });

  pendingEdits.set(editId, edit);
  log(`Edit queued: ${editId} for dashboard ${dashboardId}`);
  
  // Wake up any waiting pollers
  notifyPollers();

  // Wait for result with timeout
  const timeoutPromise = new Promise((resolve) => 
    setTimeout(() => resolve({ timeout: true }), EDIT_TIMEOUT_MS)
  );

  const result = await Promise.race([resultPromise, timeoutPromise]);
  pendingEdits.delete(editId);

  if (result.timeout) {
    log(`Edit timeout: ${editId}`);
    return sendJson(res, {
      error: 'Timeout waiting for extension to apply edit',
      hint: 'Make sure the ADX dashboard is open and the extension is installed'
    }, 504);
  }

  log(`Edit completed: ${editId}`);
  sendJson(res, result);
}

async function handleDashboardGet(req, res) {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const dashboardId = url.searchParams.get('dashboardId') || '*';

  const getId = randomUUID();
  const get = {
    id: getId,
    dashboardId,
    createdAt: Date.now(),
    result: null,
    resolve: null
  };

  const resultPromise = new Promise((resolve) => {
    get.resolve = resolve;
  });

  pendingGets.set(getId, get);
  log(`Get queued: ${getId} for dashboard ${dashboardId}`);

  // Wake up any waiting pollers
  notifyPollers();

  const timeoutPromise = new Promise((resolve) =>
    setTimeout(() => resolve({ timeout: true }), GET_TIMEOUT_MS)
  );

  const result = await Promise.race([resultPromise, timeoutPromise]);
  pendingGets.delete(getId);

  if (result.timeout) {
    log(`Get timeout: ${getId}`);
    return sendJson(res, {
      error: 'Timeout waiting for dashboard data',
      hint: 'Make sure the ADX dashboard is open'
    }, 504);
  }

  log(`Get completed: ${getId}`);
  sendJson(res, result);
}

async function handlePoll(req, res) {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const dashboardId = url.searchParams.get('dashboardId');

  if (!dashboardId) {
    return sendJson(res, { error: 'Missing dashboardId' }, 400);
  }

  // Check if there's already a pending command
  for (const [id, get] of pendingGets) {
    if (!get.result && (get.dashboardId === '*' || get.dashboardId === dashboardId)) {
      return sendJson(res, { pendingGet: { id, dashboardId: get.dashboardId } });
    }
  }

  for (const [id, edit] of pendingEdits) {
    if (!edit.result && (edit.dashboardId === '*' || edit.dashboardId === dashboardId)) {
      return sendJson(res, {
        pendingEdit: {
          id,
          dashboardId: edit.dashboardId,
          dashboard: edit.dashboard,
          description: edit.description,
          skipConfirmation: edit.skipConfirmation,
          filename: edit.filename
        }
      });
    }
  }

  for (const [id, action] of pendingActions) {
    if (!action.result && (action.dashboardId === '*' || action.dashboardId === dashboardId)) {
      return sendJson(res, {
        pendingAction: {
          id,
          dashboardId: action.dashboardId,
          type: action.type,
          params: action.params
        }
      });
    }
  }

  // No pending commands - hold the connection (long poll)
  const timeout = setTimeout(() => {
    // Remove from waiting list
    const idx = waitingPollers.findIndex(p => p.res === res);
    if (idx >= 0) waitingPollers.splice(idx, 1);
    sendJson(res, { pendingEdit: null, pendingGet: null, pendingAction: null });
  }, POLL_TIMEOUT_MS);

  waitingPollers.push({ res, dashboardId, timeout });
}

async function handleResult(req, res) {
  let data;
  try {
    data = await parseBody(req);
  } catch (e) {
    return sendJson(res, { error: 'Invalid JSON' }, 400);
  }

  const { editId, getId, result } = data;

  if (!result) {
    return sendJson(res, { error: 'Missing result' }, 400);
  }

  if (editId && pendingEdits.has(editId)) {
    const edit = pendingEdits.get(editId);
    edit.result = result;
    edit.resolve(result);
    return sendJson(res, { ok: true });
  }

  if (getId && pendingGets.has(getId)) {
    const get = pendingGets.get(getId);
    get.result = result;
    get.resolve(result);
    return sendJson(res, { ok: true });
  }

  // Handle action results (getPages, selectPage, etc.)
  const { actionId } = data;
  if (actionId && pendingActions.has(actionId)) {
    const action = pendingActions.get(actionId);
    action.result = result;
    action.resolve(result);
    return sendJson(res, { ok: true });
  }

  sendJson(res, { error: 'Request not found' }, 404);
}

async function handleConnect(req, res) {
  let data;
  try {
    data = await parseBody(req);
  } catch (e) {
    return sendJson(res, { error: 'Invalid JSON' }, 400);
  }

  const { dashboardId, title } = data;
  if (!dashboardId) {
    return sendJson(res, { error: 'Missing dashboardId' }, 400);
  }

  const isNew = !connectedDashboards.has(dashboardId);
  connectedDashboards.set(dashboardId, {
    id: dashboardId,
    title: title || 'Untitled',
    connectedAt: Date.now()
  });

  if (isNew) {
    log(`Extension connected: ${dashboardId} "${title || 'Untitled'}"`);
  }

  sendJson(res, { ok: true });
}

async function handleDisconnect(req, res) {
  let data;
  try {
    data = await parseBody(req);
  } catch (e) {
    return sendJson(res, { error: 'Invalid JSON' }, 400);
  }

  const { dashboardId } = data;
  if (dashboardId && connectedDashboards.has(dashboardId)) {
    const info = connectedDashboards.get(dashboardId);
    connectedDashboards.delete(dashboardId);
    log(`Extension disconnected: ${dashboardId} "${info.title}"`);
  }

  sendJson(res, { ok: true });
}

async function handleDashboards(req, res) {
  const dashboards = Array.from(connectedDashboards.values());
  sendJson(res, { dashboards });
}

async function handlePages(req, res) {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const dashboardId = url.searchParams.get('dashboardId') || '*';

  const actionId = randomUUID();
  const action = {
    id: actionId,
    dashboardId,
    type: 'getPages',
    params: {},
    createdAt: Date.now(),
    result: null,
    resolve: null
  };

  const resultPromise = new Promise((resolve) => {
    action.resolve = resolve;
  });

  pendingActions.set(actionId, action);
  notifyPollers();

  const timeoutPromise = new Promise((resolve) =>
    setTimeout(() => resolve({ timeout: true }), ACTION_TIMEOUT_MS)
  );

  const result = await Promise.race([resultPromise, timeoutPromise]);
  pendingActions.delete(actionId);

  if (result.timeout) {
    return sendJson(res, { error: 'Timeout waiting for pages' }, 504);
  }

  sendJson(res, result);
}

async function handleSelectPage(req, res) {
  let data;
  try {
    data = await parseBody(req);
  } catch (e) {
    return sendJson(res, { error: 'Invalid JSON' }, 400);
  }

  const { dashboardId, pageId, pageName } = data;
  const targetDashboard = dashboardId || '*';
  const pageIdOrName = pageId || pageName;

  if (!pageIdOrName) {
    return sendJson(res, { error: 'Missing pageId or pageName' }, 400);
  }

  const actionId = randomUUID();
  const action = {
    id: actionId,
    dashboardId: targetDashboard,
    type: 'selectPage',
    params: { pageIdOrName },
    createdAt: Date.now(),
    result: null,
    resolve: null
  };

  const resultPromise = new Promise((resolve) => {
    action.resolve = resolve;
  });

  pendingActions.set(actionId, action);
  log(`Select page: ${pageIdOrName} on dashboard ${targetDashboard}`);
  notifyPollers();

  const timeoutPromise = new Promise((resolve) =>
    setTimeout(() => resolve({ timeout: true }), ACTION_TIMEOUT_MS)
  );

  const result = await Promise.race([resultPromise, timeoutPromise]);
  pendingActions.delete(actionId);

  if (result.timeout) {
    return sendJson(res, { error: 'Timeout waiting for page selection' }, 504);
  }

  sendJson(res, result);
}

function handleCors(req, res) {
  res.writeHead(204, {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type'
  });
  res.end();
}

// Main server
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const path = url.pathname;

  // CORS preflight
  if (req.method === 'OPTIONS') {
    return handleCors(req, res);
  }

  try {
    if (path === '/status' && req.method === 'GET') {
      await handleStatus(req, res);
    } else if (path === '/edit' && req.method === 'POST') {
      await handleEdit(req, res);
    } else if (path === '/dashboard' && req.method === 'GET') {
      await handleDashboardGet(req, res);
    } else if (path === '/dashboards' && req.method === 'GET') {
      await handleDashboards(req, res);
    } else if (path === '/pages' && req.method === 'GET') {
      await handlePages(req, res);
    } else if (path === '/selectPage' && req.method === 'POST') {
      await handleSelectPage(req, res);
    } else if (path === '/connect' && req.method === 'POST') {
      await handleConnect(req, res);
    } else if (path === '/disconnect' && req.method === 'POST') {
      await handleDisconnect(req, res);
    } else if (path === '/poll' && req.method === 'GET') {
      await handlePoll(req, res);
    } else if (path === '/result' && req.method === 'POST') {
      await handleResult(req, res);
    } else {
      sendJson(res, { error: 'Not found' }, 404);
    }
  } catch (e) {
    console.error('Error handling request:', e);
    sendJson(res, { error: 'Internal server error' }, 500);
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`
╔═══════════════════════════════════════════════════════════╗
║       ADX Dashboard Agent Server v2.0.0 (Node.js)         ║
╠═══════════════════════════════════════════════════════════╣
║  Listening on: http://localhost:${PORT.toString().padEnd(24)}║
║                                                           ║
║  Endpoints:                                               ║
║    GET  /dashboard - Fetch current dashboard JSON         ║
║    POST /edit      - Submit dashboard edit                ║
║    GET  /poll      - Long-poll for commands (extension)   ║
║    POST /result    - Report result (extension)            ║
║    GET  /status    - Health check                         ║
╚═══════════════════════════════════════════════════════════╝
`);
});
