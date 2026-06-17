# ADX Dashboard Agent - Chrome Extension

Enables agentic editing of Azure Data Explorer dashboards without needing browser debug flags.

## Architecture

```
┌─────────────┐    POST /edit     ┌─────────────────┐    long poll    ┌─────────────────┐
│   Agent     │ ────────────────► │  Agent Server   │ ◄─────────────► │    Extension    │
│  (Copilot)  │ ◄──────────────── │  (Node.js)      │ ────────────────│  (Chrome)       │
└─────────────┘    result         │  localhost:9876 │    commands     └─────────────────┘
                                  └─────────────────┘                         │
                                                                              ▼
                                                                    ┌─────────────────┐
                                                                    │   ADX Page      │
                                                                    │  (dashboard)    │
                                                                    └─────────────────┘
```

**Zero dependencies.** The server uses only Node.js built-in modules.

## Quick Start

1. **Install extension** (one-time):
   ```bash
   # In Chrome/Edge: chrome://extensions → Developer mode → Load unpacked → select this folder
   ```

2. **Start server**:
   ```bash
   node agent-server.js
   ```

3. **Open an ADX dashboard** in Chrome/Edge

4. **Agent can now edit dashboards** via the API

## Installation (Extension)

1. Open Chrome/Edge and go to `chrome://extensions` (or `edge://extensions`)
2. Enable **Developer mode** (toggle in top right)
3. Click **Load unpacked**
4. Select this `chrome-extension` folder

## Server API

### `GET /dashboard?dashboardId=xxx`
Get the current dashboard JSON from the browser.

### `POST /edit`
Submit a dashboard edit. Blocks until the extension applies it.

```json
{
  "dashboardId": "uuid",
  "dashboard": { ... },
  "description": "What this edit does",
  "skipConfirmation": true,
  "filename": "agent-edit.json"
}
```

### `GET /status`
Health check.

## Browser Console API

On any ADX dashboard page, you have access to `window.__adxAgent`:

```javascript
// Get current dashboard JSON
const { dashboard, title, meta } = window.__adxAgent.getDashboard();

// Modify the dashboard
dashboard.tiles[0].title = '🤖 Agent Modified!';

// Replace dashboard (no file dialog!)
await window.__adxAgent.replaceDashboard(dashboard, { skipConfirmation: true });
```

## How It Works

1. **Long polling**: Extension holds a connection to the server, waiting for commands
2. **Instant response**: When agent POSTs `/edit`, server immediately responds to waiting extension
3. **File injection**: Extension intercepts ADX's file picker dialog, injecting the JSON directly
4. **Validation capture**: If ADX shows validation errors, they're captured and returned to the agent

The extension uses Manifest V3's `"world": "MAIN"` to run in the page context with full access to ADX's internal state.
