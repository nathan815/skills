---
name: adx-dashboard-live-edit
description: "Use this skill to apply changes to an Azure Data Explorer (ADX/Kusto) dashboard that is open in the browser: view the live dashboard, navigate pages/tabs, apply edits, refresh, and read tile errors. It drives a Chrome extension through a localhost daemon and validates dashboard JSON against the official schema before applying. Trigger when: editing/updating a live ADX dashboard, applying tile/query changes in the browser, refreshing, or debugging tile errors. To author and validate dashboard JSON offline, use the adx-dashboard-authoring skill."
---

# ADX Dashboard Live Edit

Apply changes to an ADX dashboard that the user has open in their browser. A Chrome
extension injects into the dashboard page and talks to a small localhost daemon; the
`client.js` CLI is the one and only way to drive it.

This skill is the **only write path**. Do not hand-build `curl` calls against the
daemon, and never fall back to a management-API write. Authoring and validating the
JSON is the job of the **adx-dashboard-authoring** skill; pull the schema and edit
there, then apply here.

## Setup

From the skill directory:

```bash
npm install
```

Node >= 18 is required.

Install the Chrome/Edge extension (one time):

1. Open `edge://extensions` (or `chrome://extensions`).
2. Enable Developer mode.
3. Click "Load unpacked" and select the `chrome-extension` folder in this skill.
4. Open the target dashboard in the browser. It connects to the daemon automatically.

You do **not** start the daemon by hand. `client.js` starts it on first use and
leaves it running detached as a localhost singleton on port 9876.

## Quick reference

Run from the skill directory:

| Task | Command |
|------|---------|
| List connected dashboards | `node client.js list` |
| Get the live dashboard JSON | `node client.js get <id>` |
| List pages/tabs | `node client.js pages <id>` |
| Navigate to a page/tab | `node client.js select-page <id> <pageIdOrName>` |
| Apply an edit (validates first) | `node client.js edit <id> <file.json>` |
| Refresh the dashboard | `node client.js refresh <id>` |
| Read tile errors | `node client.js errors <id>` |
| Daemon health | `node client.js status` |

Every command prints structured JSON to stdout and exits non-zero on failure, so a
failure is always a clear signal rather than something to work around.

If installed globally (e.g. via npm), the same commands are available as
`adx-live-edit <subcommand>`.

## The blessed edit flow

1. **Find the dashboard id**: `node client.js list`.
2. **Get the live JSON**: `node client.js get <id> > dash.json`.
3. **Author and validate in the authoring skill.** Pull the schema, read the
   relevant parts (especially `tile.json`), edit `dash.json`, and validate until
   clean. Do not improvise tile/query shapes from memory.
4. **Apply**: `node client.js edit <id> dash.json`.
   - The client re-validates against the schema first. If it is invalid, the edit
     is aborted and the validation errors are printed. Nothing reaches the browser.
   - On success the edit is applied and ADX's confirm dialog is auto-confirmed.
5. **Check tile errors**: `node client.js errors <id>`. If a tile failed (e.g. a bad
   column name), go back to step 3, fix the JSON, and apply again.

### Validation is enforced

`edit` validates the file against the official ADX schema before sending it, and the
daemon re-validates as the authoritative gate. So even a raw POST to the daemon is
checked, and a malformed dashboard never reaches a live page. Validation is always on.

In the rare case ADX's own published schema is wrong, set `ADX_SKIP_VALIDATION=1` in
the environment to bypass it. This applies to both the CLI and the daemon, and because
the daemon is a long-lived singleton you must restart it for the change to take effect
(stop the process listening on port 9876, then re-run a `client.js` command). Treat
this as a last resort, not a normal workaround for validation failures.

### Edit options

- `--no-auto-confirm` - leave ADX's confirm dialog open instead of auto-confirming.
  The result reports `pendingConfirmation` so you know a manual click is needed.

### When an edit fails or times out

The command exits non-zero with a structured error (validation errors, an edit
timeout, a dashboard-not-connected message, etc.). That error is the signal to fix
the JSON in the authoring skill and re-run `client.js edit`. Do **not** fall back to
raw `curl` against the daemon, browser devtools, or a management-API write. Those are
exactly the improvisations this skill exists to prevent; if the blessed path cannot
apply the edit, report the structured error and stop.

## Why a CLI instead of raw HTTP

Handing an agent raw endpoints invites improvisation: when a browser edit once hung
on ADX's confirm dialog, the agent fell back to a management-API write that forced a
full page reload. `client.js` removes that temptation. It owns daemon lifecycle,
validates before applying, auto-confirms the dialog with bounded waits (no silent
hang), and reports edit timeouts as structured errors so there is nothing to
work around.

## Security model

- **First-time authorization**: the user must click "Allow Edits" the first time an
  agent edits a given dashboard.
- **Per-dashboard and expires on refresh**: authorization is scoped to one dashboard
  and is cleared when the page refreshes, so re-authorization may be needed.
- **Localhost only**: the daemon listens on `127.0.0.1:9876` with no external access.

## Notes

- The daemon is a small Node HTTP server (`chrome-extension/agent-server.js`). It is a
  singleton by port bind; a second start simply exits. It lazy-loads the validator
  (ajv) only for edits, so read-only commands work even before `npm install`.
- This skill bundles a byte-identical copy of the authoring validator (`validate.js`)
  so it can re-validate before applying. The format knowledge and schema live in the
  **adx-dashboard-authoring** skill; keep the two validators in sync.
- Live edits require the dashboard to be open in the browser. If a command times out,
  make sure the dashboard tab is open and connected (`node client.js list`).
