---
name: adx-dashboards
description: "Use this skill to manage Azure Data Explorer (ADX/Kusto) dashboards. Supports listing all dashboards, getting dashboard details, updating dashboards with schema validation, and fetching the dashboard JSON schema. Trigger when: user mentions 'ADX dashboard', 'Kusto dashboard', 'Data Explorer dashboard', or wants to list/view/edit/update/validate dashboards in ADX."
---

# ADX Dashboards Skill

Manage Azure Data Explorer dashboards via the (unofficial but functional) Dashboard API.

## Quick Reference

Run all scripts with `uv run` from the skill directory (`~/.copilot/skills/adx-dashboards`):

| Task | Command |
|------|---------|
| List all dashboards | `uv run python scripts/list_dashboards.py` |
| Get a dashboard | `uv run python scripts/get_dashboard.py <dashboard_id>` |
| Update a dashboard | `uv run python scripts/update_dashboard.py <dashboard_id> <json_file>` |
| Validate JSON | `uv run python scripts/validate_dashboard.py <json_file>` |
| Fetch schema | `uv run python scripts/get_schema.py` |

Dependencies are defined in `pyproject.toml` and managed automatically by uv.

## Authentication

All scripts use `DefaultAzureCredential` from `azure-identity`. Ensure you're logged in:

```bash
az login
```

The API scope is `https://rtd-metadata.azurewebsites.net/.default`.

## API Details

**Base URL:** `https://dashboards.kusto.windows.net`

| Operation | Method | Endpoint |
|-----------|--------|----------|
| List | GET | `/api/dashboards` |
| Get | GET | `/dashboards/{id}` |
| Update | PUT | `/dashboards/{id}` |

**Schema URL:** `https://dataexplorer.azure.com/static/d/schema/55/dashboard.json`

## Workflow: Updating a Dashboard

1. **Get current dashboard** to retrieve the eTag (required for updates):
   ```bash
   uv run python scripts/get_dashboard.py abc123 > dashboard.json
   ```

2. **Edit the JSON** as needed

3. **Validate before updating** (optional but recommended):
   ```bash
   uv run python scripts/validate_dashboard.py dashboard.json
   ```

4. **Update the dashboard**:
   ```bash
   uv run python scripts/update_dashboard.py abc123 dashboard.json
   ```

The update script automatically fetches the current eTag and includes it in the request.

## Schema Validation

The dashboard JSON must conform to schema version 55. Key required fields:

- `schema_version` - Must be `"55"`
- `title` - Dashboard title
- `tiles` - Array of tile definitions
- `baseQueries` - Array of base queries
- `parameters` - Array of parameters
- `dataSources` - Array of data sources
- `pages` - Array of page definitions
- `queries` - Object mapping query IDs to definitions

Run validation before updating to catch errors early:

```bash
uv run python scripts/validate_dashboard.py my_dashboard.json
```

## Output Format

All scripts output JSON to stdout. Errors go to stderr.

**List output:**
```json
[
  {"id": "abc123", "title": "My Dashboard", ...},
  {"id": "def456", "title": "Another Dashboard", ...}
]
```

**Get output:** Full dashboard JSON including `eTag` in metadata.

**Update output:** The updated dashboard JSON returned by the API.

**Validate output:**
```json
{"valid": true}
```
or
```json
{"valid": false, "errors": ["Error message 1", "Error message 2"]}
```

## Agentic Live Editing (Browser-Based)

For real-time dashboard editing with visual preview, use the Chrome extension + agent server:

### Setup

1. **Install the Chrome extension:**
   ```
   1. Open edge://extensions (or chrome://extensions)
   2. Enable Developer mode
   3. Click "Load unpacked" → select chrome-extension folder
   ```

2. **Start the agent server:**
   ```bash
   uv run python chrome-extension/agent_server.py
   ```

3. **Open the target dashboard** in the browser

### Agent Edit Flow

The agent can now POST edits that get applied in the browser:

```bash
# Submit an edit request
curl -X POST http://localhost:9876/edit \
  -H "Content-Type: application/json" \
  -d '{
    "dashboardId": "f8537cec-8b2e-45c1-b96b-046960ead1ce",
    "dashboard": { ... modified dashboard JSON ... },
    "description": "Updated tile title",
    "skipConfirmation": true
  }'
```

The request blocks until the extension applies the edit and returns:
```json
{"success": true, "message": "Dashboard replaced (auto-confirmed)"}
```

### Security

- **First-time authorization**: User must click "Allow Edits" when an agent first tries to edit a dashboard
- **Dashboard-scoped**: Authorization is per-dashboard and expires on page refresh
- **Local only**: Server listens on localhost:9876, no external access

### Extension API (Console)

On any ADX dashboard page, `window.__adxAgent` is available:

```javascript
// Get current dashboard
const { dashboard, title } = __adxAgent.getDashboard();

// Modify and apply
dashboard.tiles[0].title = '🤖 Modified!';
await __adxAgent.replaceDashboard(dashboard, { skipConfirmation: true });
```

## Notes

- The Dashboard API is unofficial but functional (used internally by the ADX portal)
- eTag is required for updates - the script handles this automatically
- Schema version may change over time (currently v55)
- Browser-based editing requires schema_version 75 (integer), API uses 55 (string)
