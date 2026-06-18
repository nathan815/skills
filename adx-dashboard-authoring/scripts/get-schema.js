#!/usr/bin/env node
'use strict';

/*
 * Fetch and cache the full ADX dashboard schema graph for a given version.
 * Use this to learn the exact structure of tiles, queries, parameters, etc. before
 * authoring or editing a dashboard. After running, the schema files live under
 * <skill>/.cache/schema/<version>/ and can be read directly.
 *
 * tile.json is the most useful for tile/visual structure; dashboard.json is the
 * top-level shape.
 */

const fs = require('fs');
const path = require('path');
const { loadSchemaGraph, cacheDirFor, DEFAULT_SCHEMA_VERSION } = require('./validate');

async function main() {
  const arg = process.argv[2];
  const version = arg ? parseInt(arg, 10) : DEFAULT_SCHEMA_VERSION;
  if (Number.isNaN(version)) {
    process.stderr.write('Usage: get-schema.js [version]\n');
    process.exit(2);
  }

  try {
    const schemas = await loadSchemaGraph(version);
    const dir = cacheDirFor(version);
    const files = [...schemas.keys()].sort().map((name) => ({
      file: name,
      path: path.join(dir, name),
      bytes: fs.existsSync(path.join(dir, name))
        ? fs.statSync(path.join(dir, name)).size
        : null,
    }));
    process.stdout.write(JSON.stringify({ version, cacheDir: dir, files }, null, 2) + '\n');
  } catch (e) {
    process.stderr.write(JSON.stringify({ error: e.message }) + '\n');
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}
