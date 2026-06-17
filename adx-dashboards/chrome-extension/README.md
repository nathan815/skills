# ADX Dashboard Agent - Chrome Extension

Enables agentic editing of Azure Data Explorer dashboards without needing browser debug flags.

## Installation

1. Open Chrome/Edge and go to `chrome://extensions` (or `edge://extensions`)
2. Enable **Developer mode** (toggle in top right)
3. Click **Load unpacked**
4. Select this `chrome-extension` folder

## Usage

### From Browser Console

On any ADX dashboard page, you have access to `window.__adxAgent`:

```javascript
// Get current dashboard JSON
const { dashboard, title, meta } = window.__adxAgent.getDashboard();

// Modify the dashboard
dashboard.tiles[0].title = '🤖 Agent Modified!';

// Replace dashboard (no file dialog!)
await window.__adxAgent.replaceDashboard(dashboard, { skipConfirmation: true });
```

### From Extension Popup

Click the extension icon to:
- See connection status
- Get dashboard JSON
- Copy JSON to clipboard

### API Reference

#### `__adxAgent.getDashboard()`
Returns current dashboard state:
```javascript
{
  dashboard: { tiles: [...], dataSources: [...], ... },
  title: "Dashboard Title",
  meta: { ... }
}
```

#### `__adxAgent.replaceDashboard(dashboardJson, options)`
Replaces the current dashboard with new JSON.

Options:
- `skipConfirmation` (boolean): Auto-click Continue on confirmation dialog
- `filename` (string): Name shown in confirmation dialog

Returns a Promise.

#### `__adxAgent.modifyTile(tileId, changes)`
Shorthand to modify a single tile and save.

```javascript
await __adxAgent.modifyTile('tile-abc-123', { title: 'New Title' });
```

## How It Works

The extension intercepts the native file picker dialog that appears when you click "File > Replace dashboard with file". Instead of opening the file picker, it:

1. Creates a Blob with your JSON
2. Injects it directly into the file input
3. Triggers the change event
4. Optionally auto-confirms the replacement

This allows fully automated dashboard updates without any user interaction.

## For Copilot Integration

The extension exposes `window.__adxAgent` which Copilot can access via Chrome DevTools MCP or the browser canvas to programmatically edit dashboards.
