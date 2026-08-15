#!/usr/bin/env node
// analyze-image-tool prepare script
// dsh plugin add via github: fetches source; this script ensures lib/ exists.
// lib/index.js is already committed — no build step needed for this plugin.
const fs = require('fs');
const path = require('path');

const libDir = path.join(__dirname, 'lib');
if (!fs.existsSync(libDir)) {
  console.error('[analyze-image-tool] ERROR: lib/ directory not found. Did you forget to commit built output?');
  process.exit(1);
}

const entries = ['index.js', 'client.js', 'vlm.js'];
for (const entry of entries) {
  const file = path.join(libDir, entry);
  if (!fs.existsSync(file)) {
    console.error(`[analyze-image-tool] ERROR: ${entry} not found in lib/`);
    process.exit(1);
  }
}

console.log('[analyze-image-tool] lib/ ready.');
