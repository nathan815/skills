(function() {
  'use strict';

  const AGENT_SERVER_PORT = 9876;
  const authorizedDashboards = new Set();
  const handledEditIds = new Set();
  let dialogOpen = false;
  let polling = false;

  function getCurrentDashboardId() {
    const match = window.location.pathname.match(/\/dashboards\/([a-f0-9-]+)/i);
    return match ? match[1] : null;
  }

  function extractValidationErrors() {
    // Look for validation error dialog/container
    // ADX shows "Failed to validate your dashboard file" with error details
    const errorHeader = Array.from(document.querySelectorAll('*')).find(el => 
      el.textContent.includes('Failed to validate') && el.textContent.length < 200
    );
    
    if (!errorHeader) return null;

    // Find the error container (usually a modal or panel)
    let container = errorHeader.closest('[role="dialog"]') || 
                    errorHeader.closest('.ms-Panel') ||
                    errorHeader.parentElement?.parentElement;
    
    if (!container) return null;

    // Extract all error messages
    const errors = [];
    const errorBlocks = container.querySelectorAll('[class*="error"], [class*="Error"], pre, code');
    
    // Also look for "Error found at:" patterns in text
    const allText = container.innerText;
    const errorMatches = allText.match(/Error found at:[\s\S]*?Message:[\s\S]*?(?=Error found at:|$)/g);
    
    if (errorMatches) {
      errors.push(...errorMatches.map(e => e.trim()));
    }

    if (errors.length === 0) {
      // Fallback: grab all text from the error container
      const fullText = container.innerText.trim();
      if (fullText.includes('Failed to validate')) {
        return fullText.substring(0, 2000); // Limit length
      }
    }

    return errors.length > 0 ? errors.join('\n\n') : null;
  }

  function closeValidationErrorDialog() {
    // Find and click the Close button on validation error dialogs
    const closeBtn = Array.from(document.querySelectorAll('button')).find(b => 
      b.textContent.trim() === 'Close' || b.textContent.includes('Close')
    );
    if (closeBtn) {
      closeBtn.click();
    }
    
    // Also try clicking any dialog dismiss button
    const dismissBtn = document.querySelector('[data-testid="dismiss-button"]') ||
                       document.querySelector('.ms-Panel-closeButton') ||
                       document.querySelector('[aria-label="Close"]');
    if (dismissBtn) {
      dismissBtn.click();
    }
  }

  window.__adxAgent = {
    version: '1.0.0',
    authorizedDashboards,

    getDashboard: function() {
      const rtd = window.__rtd;
      if (!rtd?.state?.state?.hostState?.dashboard) {
        return { error: 'Dashboard not loaded or not on a dashboard page' };
      }
      return {
        dashboard: JSON.parse(JSON.stringify(rtd.state.state.hostState.dashboard)),
        title: rtd.state.state.hostState.title,
        meta: rtd.state.state.hostState.meta,
        selectedPageId: rtd.state.state.hostState.selectedPageId || null
      };
    },

    getPages: function() {
      const rtd = window.__rtd;
      if (!rtd?.state?.state?.hostState?.dashboard?.pages) {
        return { error: 'Dashboard not loaded' };
      }
      const pages = rtd.state.state.hostState.dashboard.pages;
      const selectedPageId = rtd.state.state.hostState.selectedPageId;
      return {
        pages: pages.map(p => ({ id: p.id, name: p.name })),
        selectedPageId
      };
    },

    selectPage: function(pageIdOrName) {
      // Find the tab element by page ID or name and click it
      const pages = window.__rtd?.state?.state?.hostState?.dashboard?.pages || [];
      
      // Resolve pageIdOrName to actual page
      let targetPage = pages.find(p => p.id === pageIdOrName || p.name === pageIdOrName);
      if (!targetPage) {
        return { error: `Page not found: ${pageIdOrName}` };
      }

      // Find the menuitemradio with matching page name
      const tabElement = Array.from(document.querySelectorAll('[role="menuitemradio"]'))
        .find(el => el.textContent.trim() === targetPage.name);
      
      if (!tabElement) {
        return { error: `Tab element not found for page: ${targetPage.name}` };
      }

      tabElement.click();
      return { success: true, pageId: targetPage.id, pageName: targetPage.name };
    },

    refresh: function() {
      // Click the command bar refresh button
      const refreshBtn = document.querySelector('button[aria-label="Refresh"].ms-Button--commandBar');
      if (!refreshBtn) {
        return { error: 'Refresh button not found' };
      }
      refreshBtn.click();
      return { success: true, message: 'Dashboard refresh triggered' };
    },

    getErrors: function() {
      // Find tile error containers and extract error info with tile IDs
      const errors = [];
      const errorContainers = document.querySelectorAll('[class*="bucketErrorContainer"]');
      
      errorContainers.forEach(el => {
        // Walk up to find element with data-tile-id
        let parent = el;
        while (parent && !parent.dataset.tileId) {
          parent = parent.parentElement;
        }
        
        const errorLabel = el.querySelector('[class*="bucketErrorLabel"]');
        errors.push({
          tileId: parent?.dataset?.tileId || null,
          errorText: errorLabel?.textContent || 'An error occurred'
        });
      });

      return { errors };
    },

    replaceDashboard: function(dashboardJson, options = {}) {
      return new Promise((resolve, reject) => {
        const skipConfirmation = options.skipConfirmation || false;
        const filename = options.filename || 'agent-update.json';

        if (!dashboardJson || typeof dashboardJson !== 'object') {
          reject(new Error('Invalid dashboard JSON'));
          return;
        }

        if (!dashboardJson.schema_version) {
          dashboardJson.schema_version = 75;
        }

        const jsonContent = JSON.stringify(dashboardJson, null, 2);
        const originalClick = HTMLInputElement.prototype.click;
        let intercepted = false;

        HTMLInputElement.prototype.click = function() {
          if (this.type === 'file' && this.accept === '.json' && !intercepted) {
            intercepted = true;
            const blob = new Blob([jsonContent], { type: 'application/json' });
            const file = new File([blob], filename, { type: 'application/json' });
            const dt = new DataTransfer();
            dt.items.add(file);
            this.files = dt.files;

            setTimeout(() => {
              this.dispatchEvent(new Event('change', { bubbles: true }));
              HTMLInputElement.prototype.click = originalClick;

              // Wait for validation, then check for errors or success
              setTimeout(() => {
                // Check for validation error dialog
                const errorText = extractValidationErrors();
                if (errorText) {
                  reject(new Error(errorText));
                  return;
                }

                if (skipConfirmation) {
                  const continueBtn = document.querySelector('[data-testid="confirm-button"]') ||
                    Array.from(document.querySelectorAll('button')).find(b => b.textContent === 'Continue');
                  if (continueBtn) {
                    continueBtn.click();
                    resolve({ success: true, message: 'Dashboard replaced (auto-confirmed)' });
                  } else {
                    resolve({ success: true, message: 'Dashboard injected, waiting for confirmation' });
                  }
                } else {
                  resolve({ success: true, message: 'Dashboard injected, waiting for confirmation' });
                }
              }, 800);
            }, 50);

            return;
          }
          return originalClick.call(this);
        };

        this._clickFileReplace().then(() => {}).catch(reject);
      });
    },

    _clickFileReplace: function() {
      return new Promise((resolve, reject) => {
        // Close any existing error dialog first
        closeValidationErrorDialog();
        
        const fileMenu = Array.from(document.querySelectorAll('[role="menuitem"]'))
          .find(el => el.textContent.includes('File'));
        if (!fileMenu) { reject(new Error('File menu not found')); return; }
        fileMenu.click();

        setTimeout(() => {
          const replaceBtn = Array.from(document.querySelectorAll('button'))
            .find(b => b.textContent.includes('Replace dashboard with file'));
          if (!replaceBtn) { reject(new Error('Replace button not found')); return; }
          replaceBtn.click();
          resolve();
        }, 200);
      });
    }
  };

  // Long polling for agent commands
  async function pollAgentServer() {
    if (polling) return;  // Prevent concurrent polls
    polling = true;
    
    const dashboardId = getCurrentDashboardId();
    if (!dashboardId) {
      polling = false;
      setTimeout(pollAgentServer, 1000);  // Retry when dashboard loads
      return;
    }

    // Create abort controller for this poll
    pollAbortController = new AbortController();

    try {
      const response = await fetch(
        `http://localhost:${AGENT_SERVER_PORT}/poll?dashboardId=${dashboardId}`,
        { signal: pollAbortController.signal }
      );
      polling = false;
      
      if (!response.ok) {
        setTimeout(pollAgentServer, 1000);
        return;
      }

      const data = await response.json();
      
      // Handle get requests (no auth needed - read only)
      if (data.pendingGet && !handledEditIds.has(data.pendingGet.id)) {
        handledEditIds.add(data.pendingGet.id);
        await handlePendingGet(data.pendingGet);
      }
      
      // Handle actions (getPages, selectPage, etc.)
      if (data.pendingAction && !handledEditIds.has(data.pendingAction.id)) {
        handledEditIds.add(data.pendingAction.id);
        await handlePendingAction(data.pendingAction);
      }
      
      // Handle edit requests
      if (data.pendingEdit && !handledEditIds.has(data.pendingEdit.id)) {
        handledEditIds.add(data.pendingEdit.id);
        await handlePendingEdit(data.pendingEdit);
      }
      
      // Immediately poll again (long polling returns quickly when there's a command)
      pollAgentServer();
    } catch (e) {
      polling = false;
      // Ignore abort errors (expected during navigation)
      if (e.name === 'AbortError') return;
      // Server not available, retry after delay
      setTimeout(pollAgentServer, 2000);
    }
  }

  async function handlePendingGet(getReq) {
    const result = window.__adxAgent.getDashboard();
    await sendGetResult(getReq.id, result);
  }

  async function handlePendingAction(action) {
    const actionId = action.id;
    let result;

    try {
      switch (action.type) {
        case 'getPages':
          result = window.__adxAgent.getPages();
          break;
        case 'selectPage':
          result = window.__adxAgent.selectPage(action.params.pageIdOrName);
          break;
        case 'refresh':
          result = window.__adxAgent.refresh();
          break;
        case 'getErrors':
          result = window.__adxAgent.getErrors();
          break;
        default:
          result = { error: `Unknown action type: ${action.type}` };
      }
    } catch (e) {
      result = { error: e.message };
    }

    await sendActionResult(actionId, result);
  }

  async function handlePendingEdit(edit) {
    const dashboardId = getCurrentDashboardId();
    const editId = edit.id;

    if (!authorizedDashboards.has(dashboardId)) {
      dialogOpen = true;
      const confirmed = await showAuthorizationDialog(dashboardId, edit);
      dialogOpen = false;
      if (!confirmed) {
        await sendEditResult(editId, { success: false, error: 'User declined authorization' });
        return;
      }
      authorizedDashboards.add(dashboardId);
    }

    if (edit.dashboardId && edit.dashboardId !== '*' && edit.dashboardId !== dashboardId) {
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
        <p style="margin: 0 0 12px 0;">An agent wants to edit this dashboard:</p>
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

  async function sendGetResult(getId, result) {
    try {
      await fetch(`http://localhost:${AGENT_SERVER_PORT}/result`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ getId, result })
      });
    } catch (e) {
      console.error('[ADX Agent] Failed to send get result:', e);
    }
  }

  async function sendActionResult(actionId, result) {
    try {
      await fetch(`http://localhost:${AGENT_SERVER_PORT}/result`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ actionId, result })
      });
    } catch (e) {
      console.error('[ADX Agent] Failed to send action result:', e);
    }
  }

  async function connectToServer() {
    const dashboardId = getCurrentDashboardId();
    if (!dashboardId) return false;

    const dashData = window.__adxAgent.getDashboard();
    // Wait for dashboard to actually load (not just URL match)
    if (dashData.error || !dashData.title) {
      return false;  // Will retry in start()
    }

    try {
      await fetch(`http://localhost:${AGENT_SERVER_PORT}/connect`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ dashboardId, title: dashData.title })
      });
      return true;
    } catch (e) {
      return false;
    }
  }

  function disconnectFromServer() {
    if (!currentDashboardId) return;

    // Use sendBeacon for reliable delivery during page unload
    navigator.sendBeacon(
      `http://localhost:${AGENT_SERVER_PORT}/disconnect`,
      JSON.stringify({ dashboardId: currentDashboardId })
    );
  }

  // Disconnect when page unloads
  window.addEventListener('beforeunload', disconnectFromServer);

  // Track current dashboard for SPA navigation
  let currentDashboardId = null;
  let pollAbortController = null;

  async function handleDashboardChange() {
    const newDashboardId = getCurrentDashboardId();
    
    // No change
    if (newDashboardId === currentDashboardId) return;
    
    // Disconnect from old dashboard
    if (currentDashboardId) {
      navigator.sendBeacon(
        `http://localhost:${AGENT_SERVER_PORT}/disconnect`,
        JSON.stringify({ dashboardId: currentDashboardId })
      );
      // Abort any pending poll
      if (pollAbortController) {
        pollAbortController.abort();
        pollAbortController = null;
      }
    }
    
    currentDashboardId = newDashboardId;
    
    // Connect to new dashboard (if on a dashboard page)
    if (newDashboardId) {
      // Wait for dashboard data to load
      const waitForData = async () => {
        const dashData = window.__adxAgent.getDashboard();
        if (dashData.error || !dashData.title) {
          setTimeout(waitForData, 500);
          return;
        }
        const connected = await connectToServer();
        if (connected) {
          pollAgentServer();
        } else {
          setTimeout(waitForData, 500);
        }
      };
      waitForData();
    }
  }

  // Detect SPA navigation via history API
  const originalPushState = history.pushState;
  const originalReplaceState = history.replaceState;
  
  history.pushState = function(...args) {
    originalPushState.apply(this, args);
    handleDashboardChange();
  };
  
  history.replaceState = function(...args) {
    originalReplaceState.apply(this, args);
    handleDashboardChange();
  };
  
  window.addEventListener('popstate', handleDashboardChange);

  // Start: connect then poll
  async function start() {
    const dashboardId = getCurrentDashboardId();
    if (!dashboardId) {
      setTimeout(start, 500);
      return;
    }
    
    currentDashboardId = dashboardId;
    
    const connected = await connectToServer();
    if (!connected) {
      // Dashboard data not ready yet, retry
      setTimeout(start, 500);
      return;
    }
    
    pollAgentServer();
  }

  start();

  console.log('[ADX Agent] Main world loaded. window.__adxAgent ready.');
})();
