---
name: adx-dashboard-authoring
description: "Use this skill to author and validate Azure Data Explorer (ADX/Kusto) dashboard JSON offline. It teaches the dashboard JSON format, pulls the official ADX schema, validates a dashboard against it, and can read existing dashboards (read-only). Trigger when: building or editing ADX dashboard JSON, adding/updating tiles, queries, parameters, or pages, or validating dashboard JSON. To apply changes to a live dashboard in the browser, use the adx-dashboard-live-edit skill."
---

# ADX Dashboard Authoring

Author and validate Azure Data Explorer dashboard JSON against the official ADX
schema. This skill is browser-free and the canonical source of JSON-format
knowledge. It does **not** apply changes to a live dashboard. To apply edits in
the browser, use the **adx-dashboard-live-edit** skill.

## Setup

From the skill directory:

```bash
npm install
```

Node >= 18 is required (uses the built-in global `fetch`).

## Quick reference

| Task | Command |
|------|---------|
| Pull/cache the schema | `node scripts/get-schema.js [version]` |
| Validate dashboard JSON | `node scripts/validate.js <file.json>` |
| Get a dashboard (read-only) | `node scripts/get-dashboard.js <dashboard_id>` |
| List dashboards (read-only) | `node scripts/list-dashboards.js` |

## Always validate against the schema

The dashboard JSON must strictly follow the official ADX schema. Do not improvise
tile, query, or parameter shapes from memory. Pull the schema first, read the
relevant parts, then build or edit, then validate.

### 1. Pull the schema

```bash
node scripts/get-schema.js
```

This crawls the full schema graph for the target version (default 76) and caches
all files under `.cache/schema/<version>/`. The graph is 7 files:

- `dashboard.json` - top-level shape (tiles, queries, parameters, pages, dataSources, baseQueries, embeddedApps)
- `tile.json` - tile and visual structure (the big one; read this when adding/editing tiles)
- `query.json` - query definitions
- `baseQuery.json` - base queries
- `parameter.json` - parameter definitions
- `dataSource.json` - data source (cluster/database) definitions
- `embeddedApp.json` - embedded apps

Read the cached files directly to learn exact field names and allowed values
before authoring. For example, read `.cache/schema/76/tile.json` before adding a
tile.

### 2. Validate

```bash
node scripts/validate.js my_dashboard.json
```

Output on success:

```json
{ "valid": true }
```

Output on failure (exit code 1):

```json
{
  "valid": false,
  "errors": [
    { "path": "/tiles/0", "message": "must be object" }
  ]
}
```

`path` is the JSON pointer to the offending value. Fix each error and re-run until
valid. Exit codes: `0` valid, `1` invalid, `2` usage/parse error.

The validator is version-aware: it reads `schema_version` from the dashboard and
validates against that version's schema, defaulting to 76 if missing. Top-level
keys starting with `_` (e.g. `_metadata`) are ignored during validation.

## Reading existing dashboards (read-only)

These scripts read from the ADX Dashboard management API. They never write. To
apply changes, use the live-edit skill.

Authentication uses `DefaultAzureCredential` from `@azure/identity`. Make sure you
are logged in:

```bash
az login
```

List dashboards:

```bash
node scripts/list-dashboards.js
```

Get one dashboard (captures the eTag under `_metadata.eTag`):

```bash
node scripts/get-dashboard.js <dashboard_id> > dashboard.json
```

## Typical workflow

1. Pull the schema: `node scripts/get-schema.js`, then read the relevant cached
   schema files (especially `tile.json`).
2. Start from an existing dashboard (`get-dashboard.js`) or build new JSON.
3. Edit the JSON to add/update tiles, queries, parameters, or pages.
4. Validate: `node scripts/validate.js dashboard.json`. Repeat until valid.
5. To apply the change to the live dashboard, hand off to the
   **adx-dashboard-live-edit** skill, which re-validates and applies via the
   browser.

## Notes

- The Dashboard management API is unofficial but functional (used by the ADX portal).
- Schema versions change over time. The default here is 76; pass a version to
  `get-schema.js` to target a different one.
- This skill is the source of truth for dashboard JSON format and validation.
  The live-edit skill bundles an identical copy of the validator so it can
  re-validate before applying, but the format knowledge lives here.
