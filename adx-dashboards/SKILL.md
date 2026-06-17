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

For real-time dashboard editing with visual preview, use the Chrome extension + agent server. This enables agents to view, edit, navigate, refresh, and monitor tile errors on dashboards the user has open in their browser.

### Setup

1. **Install the Chrome extension:**
   - Open `edge://extensions` (or `chrome://extensions`)
   - Enable Developer mode
   - Click "Load unpacked" → select `chrome-extension` folder

2. **Start the agent server** (zero dependencies, just Node.js):
   ```bash
   node chrome-extension/agent-server.js
   ```

3. **Open the target dashboard** in the browser — it will automatically connect to the agent server

### REST API (localhost:9876)

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/dashboards` | GET | List all connected dashboards |
| `/dashboards/:id` | GET | Get dashboard JSON |
| `/dashboards/:id/pages` | GET | List pages/tabs in dashboard |
| `/dashboards/:id/selectPage` | POST | Navigate to a page (body: `{"pageId": "..."}`) |
| `/dashboards/:id/edit` | POST | Apply dashboard edit |
| `/dashboards/:id/refresh` | POST | Refresh dashboard data |
| `/dashboards/:id/errors` | GET | Get tile errors for debugging |

### Workflow: Agent Edits a Dashboard

1. **List connected dashboards:**
   ```bash
   curl http://localhost:9876/dashboards
   # Returns: [{"id": "abc123", "title": "My Dashboard"}, ...]
   ```

2. **Get current dashboard JSON:**
   ```bash
   curl http://localhost:9876/dashboards/abc123
   # Returns full dashboard JSON with all tiles, queries, pages
   ```

3. **Make your edits to the JSON**, then submit:
   ```bash
   curl -X POST http://localhost:9876/dashboards/abc123/edit \
     -H "Content-Type: application/json" \
     -d '{
       "dashboard": { ... modified dashboard JSON ... },
       "description": "Updated tile title",
       "skipConfirmation": true
     }'
   ```

4. **Refresh to see changes immediately:**
   ```bash
   curl -X POST http://localhost:9876/dashboards/abc123/refresh
   ```

5. **Check for tile errors** (if a tile shows errors after edit):
   ```bash
   curl http://localhost:9876/dashboards/abc123/errors
   # Returns: {"errors": [{"tileId": "tile-uuid", "message": "..."}]}
   ```

### Navigating Pages/Tabs

Dashboards can have multiple pages. To switch:

```bash
# List available pages
curl http://localhost:9876/dashboards/abc123/pages
# Returns: {"pages": [{"id": "page1", "name": "Overview"}, {"id": "page2", "name": "Details"}], "selectedPageId": "page1"}

# Navigate to a different page
curl -X POST http://localhost:9876/dashboards/abc123/selectPage \
  -H "Content-Type: application/json" \
  -d '{"pageId": "page2"}'
```

### Self-Correction with Errors API

If an edit causes tile errors, the agent can detect and fix them:

```bash
# After an edit, check for errors
curl http://localhost:9876/dashboards/abc123/errors
# Returns: {"errors": [{"tileId": "abc", "message": "Query failed: column 'foo' not found"}]}
```

The agent can then re-fetch the dashboard, fix the issue (e.g., correct column name), and re-submit the edit.

### Security

- **First-time authorization**: User must click "Allow Edits" when an agent first tries to edit a dashboard
- **Dashboard-scoped**: Authorization is per-dashboard and expires on page refresh
- **Local only**: Server listens on localhost:9876, no external access

## Notes

- The Dashboard API is unofficial but functional (used internally by the ADX portal)
- eTag is required for updates - the script handles this automatically
- Schema version may change over time (currently v55)
- Browser-based editing requires schema_version 75 (integer), API uses 55 (string)
