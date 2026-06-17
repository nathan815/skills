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

## Notes

- The Dashboard API is unofficial but functional (used internally by the ADX portal)
- eTag is required for updates - the script handles this automatically
- Schema version may change over time (currently v55)
