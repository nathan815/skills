// ADX Dashboard Agent - Content Script
// Injected into dataexplorer.azure.com/dashboards/* pages

(function() {
  'use strict';

  const AGENT_SERVER_PORT = 9876;
  const POLL_INTERVAL_MS = 1000;

  // Track which dashboards user has authorized for agent edits
  const authorizedDashboards = new Set();

  // Get current dashboard ID from URL
  function getCurrentDashboardId() {
    const match = window.location.pathname.match(/\/dashboards\/([a-f0-9-]+)/i);
    return match ? match[1] : null;
  }

  // Expose API on window for external access
  window.__adxAgent = {
    version: '1.0.0',
    authorizedDashboards,

    // Get current dashboard JSON
    getDashboard: function() {
      const rtd = window.__rtd;
      if (!rtd?.state?.state?.hostState?.dashboard) {
        return { error: 'Dashboard not loaded or not on a dashboard page' };
      }
      return {
        dashboard: JSON.parse(JSON.stringify(rtd.state.state.hostState.dashboard)),
        title: rtd.state.state.hostState.title,
        meta: rtd.state.state.hostState.meta
      };
    },

    // Replace dashboard with new JSON (no file dialog!)
    replaceDashboard: function(dashboardJson, options = {}) {
      return new Promise((resolve, reject) => {
        const skipConfirmation = options.skipConfirmation || false;
        const filename = options.filename || 'agent-update.json';

        // Validate input
        if (!dashboardJson || typeof dashboardJson !== 'object') {
          reject(new Error('Invalid dashboard JSON'));
          return;
        }

        // Ensure schema version
        if (!dashboardJson.schema_version) {
          dashboardJson.schema_version = 75;
        }

        const jsonContent = JSON.stringify(dashboardJson, null, 2);

        // Override click to intercept file input
        const originalClick = HTMLInputElement.prototype.click;
        let intercepted = false;

        HTMLInputElement.prototype.click = function() {
          if (this.type === 'file' && this.accept === '.json' && !intercepted) {
            intercepted = true;

            // Inject our JSON file
            const blob = new Blob([jsonContent], { type: 'application/json' });
            const file = new File([blob], filename, { type: 'application/json' });
            const dt = new DataTransfer();
            dt.items.add(file);
            this.files = dt.files;

            setTimeout(() => {
              this.dispatchEvent(new Event('change', { bubbles: true }));
              HTMLInputElement.prototype.click = originalClick;

              // Wait for confirmation dialog
              setTimeout(() => {
                if (skipConfirmation) {
                  // Auto-click Continue
                  const continueBtn = document.querySelector('[data-testid="confirm-button"]') ||
                    Array.from(document.querySelectorAll('button')).find(b => b.textContent === 'Continue');
                  if (continueBtn) {
                    continueBtn.click();
                    resolve({ success: true, message: 'Dashboard replaced (auto-confirmed)' });
                  } else {
                    resolve({ success: true, message: 'Dashboard injected, waiting for user confirmation' });
                  }
                } else {
                  resolve({ success: true, message: 'Dashboard injected, waiting for user confirmation' });
                }
              }, 500);
            }, 50);

            return; // Don't open native dialog
          }
          return originalClick.call(this);
        };

        // Click File > Replace menu
        this._clickFileReplace().then(() => {
          // Intercept is set up, menu click will trigger it
        }).catch(reject);
      });
    },

    // Helper: Click File > Replace menu item
    _clickFileReplace: function() {
      return new Promise((resolve, reject) => {
        // Find and click File menu
        const fileMenu = Array.from(document.querySelectorAll('[role="menuitem"]'))
          .find(el => el.textContent.trim() === 'File');

        if (!fileMenu) {
          reject(new Error('File menu not found'));
          return;
        }

        fileMenu.click();

        // Wait for menu to open, then click Replace
        setTimeout(() => {
          const replaceBtn = Array.from(document.querySelectorAll('button'))
            .find(b => b.textContent.includes('Replace dashboard with file'));

          if (!replaceBtn) {
            reject(new Error('Replace button not found'));
            return;
          }

          replaceBtn.click();
          resolve();
        }, 200);
      });
    },

    // Modify a specific tile
    modifyTile: function(tileId, changes) {
      const current = this.getDashboard();
      if (current.error) return current;

      const dashboard = current.dashboard;
      const tile = dashboard.tiles.find(t => t.id === tileId);
      if (!tile) {
        return { error: `Tile ${tileId} not found` };
      }

      Object.assign(tile, changes);
      return this.replaceDashboard(dashboard, { skipConfirmation: true });
    }
  };

  // Listen for messages from popup or external scripts
  window.addEventListener('message', (event) => {
    if (event.source !== window) return;
    if (event.data.type !== 'ADX_AGENT_REQUEST') return;

    const { action, payload, requestId } = event.data;

    let result;
    try {
      switch (action) {
        case 'getDashboard':
          result = window.__adxAgent.getDashboard();
          break;
        case 'replaceDashboard':
          window.__adxAgent.replaceDashboard(payload.dashboard, payload.options)
            .then(r => postResult(requestId, r))
            .catch(e => postResult(requestId, { error: e.message }));
          return; // Async
        default:
          result = { error: `Unknown action: ${action}` };
      }
    } catch (e) {
      result = { error: e.message };
    }

    postResult(requestId, result);
  });

  function postResult(requestId, result) {
    window.postMessage({
      type: 'ADX_AGENT_RESPONSE',
      requestId,
      result
    }, '*');
  }

  // ========== Agent Server Connection ==========

  let agentServerConnected = false;
  let pollTimer = null;

  async function pollAgentServer() {
    const dashboardId = getCurrentDashboardId();
    if (!dashboardId) return;

    try {
      const response = await fetch(`http://localhost:${AGENT_SERVER_PORT}/poll?dashboardId=${dashboardId}`, {
        method: 'GET',
        headers: { 'Accept': 'application/json' }
      });

      if (!response.ok) {
        if (agentServerConnected) {
          console.log('[ADX Agent] Server disconnected');
          agentServerConnected = false;
        }
        return;
      }

      if (!agentServerConnected) {
        console.log('[ADX Agent] Connected to agent server on port', AGENT_SERVER_PORT);
        agentServerConnected = true;
      }

      const data = await response.json();
      if (data.pendingEdit) {
        await handlePendingEdit(data.pendingEdit);
      }
    } catch (e) {
      // Server not running - silent fail
      if (agentServerConnected) {
        console.log('[ADX Agent] Server connection lost');
        agentServerConnected = false;
      }
    }
  }

  async function handlePendingEdit(edit) {
    const dashboardId = getCurrentDashboardId();
    const editId = edit.id;

    // Check if this dashboard is authorized
    if (!authorizedDashboards.has(dashboardId)) {
      // Show confirmation dialog
      const confirmed = await showAuthorizationDialog(dashboardId, edit);
      if (!confirmed) {
        await sendEditResult(editId, { success: false, error: 'User declined authorization' });
        return;
      }
      authorizedDashboards.add(dashboardId);
    }

    // Validate dashboard ID matches
    if (edit.dashboardId && edit.dashboardId !== dashboardId) {
      await sendEditResult(editId, { 
        success: false, 
        error: `Dashboard ID mismatch: edit is for ${edit.dashboardId}, current is ${dashboardId}` 
      });
      return;
    }

    try {
      const result = await window.__adxAgent.replaceDashboard(edit.dashboard, {
        skipConfirmation: edit.skipConfirmation || false,
        filename: edit.filename || 'agent-edit.json'
      });
      await sendEditResult(editId, result);
    } catch (e) {
      await sendEditResult(editId, { success: false, error: e.message });
    }
  }

  async function showAuthorizationDialog(dashboardId, edit) {
    return new Promise((resolve) => {
      const overlay = document.createElement('div');
      overlay.style.cssText = `
        position: fixed; top: 0; left: 0; right: 0; bottom: 0;
        background: rgba(0,0,0,0.5); z-index: 999999;
        display: flex; align-items: center; justify-content: center;
      `;

      const dialog = document.createElement('div');
      dialog.style.cssText = `
        background: white; padding: 24px; border-radius: 8px;
        max-width: 500px; box-shadow: 0 4px 20px rgba(0,0,0,0.3);
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      `;

      const currentDashboard = window.__adxAgent.getDashboard();
      const title = currentDashboard.title || 'Unknown Dashboard';

      dialog.innerHTML = `
        <h2 style="margin: 0 0 16px 0; color: #0078d4;">🤖 Agent Edit Request</h2>
        <p style="margin: 0 0 12px 0;">
          An agent wants to edit this dashboard:
        </p>
        <p style="margin: 0 0 12px 0; padding: 12px; background: #f3f3f3; border-radius: 4px;">
          <strong>${title}</strong><br>
          <code style="font-size: 12px; color: #666;">${dashboardId}</code>
        </p>
        <p style="margin: 0 0 16px 0; font-size: 14px; color: #666;">
          ${edit.description || 'No description provided'}
        </p>
        <p style="margin: 0 0 16px 0; font-size: 13px; color: #a4262c;">
          ⚠️ This will allow the agent to modify this dashboard until you refresh the page.
        </p>
        <div style="display: flex; gap: 12px; justify-content: flex-end;">
          <button id="adx-agent-deny" style="
            padding: 8px 16px; border: 1px solid #ccc; border-radius: 4px;
            background: white; cursor: pointer; font-size: 14px;
          ">Deny</button>
          <button id="adx-agent-allow" style="
            padding: 8px 16px; border: none; border-radius: 4px;
            background: #0078d4; color: white; cursor: pointer; font-size: 14px;
          ">Allow Edits</button>
        </div>
      `;

      overlay.appendChild(dialog);
      document.body.appendChild(overlay);

      dialog.querySelector('#adx-agent-allow').addEventListener('click', () => {
        document.body.removeChild(overlay);
        resolve(true);
      });

      dialog.querySelector('#adx-agent-deny').addEventListener('click', () => {
        document.body.removeChild(overlay);
        resolve(false);
      });
    });
  }

  async function sendEditResult(editId, result) {
    try {
      await fetch(`http://localhost:${AGENT_SERVER_PORT}/result`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ editId, result })
      });
    } catch (e) {
      console.error('[ADX Agent] Failed to send result:', e);
    }
  }

  // Start polling
  function startPolling() {
    if (pollTimer) return;
    pollTimer = setInterval(pollAgentServer, POLL_INTERVAL_MS);
    pollAgentServer(); // Initial poll
  }

  function stopPolling() {
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
  }

  // Start polling when on a dashboard page
  if (getCurrentDashboardId()) {
    startPolling();
  }

  // Watch for URL changes (SPA navigation)
  let lastUrl = location.href;
  new MutationObserver(() => {
    if (location.href !== lastUrl) {
      lastUrl = location.href;
      if (getCurrentDashboardId()) {
        startPolling();
      } else {
        stopPolling();
      }
    }
  }).observe(document, { subtree: true, childList: true });

  console.log('[ADX Agent] Content script loaded. Access via window.__adxAgent');
  console.log('[ADX Agent] Polling agent server on port', AGENT_SERVER_PORT);
})();
