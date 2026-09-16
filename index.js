#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

// ------------------------------------------------------------------
// Adapter registry — this is the whole "source-agnostic" contract:
// every adapter is just `async (sourceConfig) => Area[]`. Add a new
// source by writing one function with that signature and registering
// it here; nothing else in this file needs to change.
// ------------------------------------------------------------------
const ADAPTERS = {
  nps: require('./adapters/nps'),
  ridb: require('./adapters/ridb'),
  geojson: require('./adapters/geojson')
};

function resolveSecrets(obj) {
  // Lets a config value be written as "env:SOME_VAR" to pull from the
  // environment instead of hardcoding a key in the (possibly committed)
  // config file.
  const out = Array.isArray(obj) ? [] : {};
  for (const [k, v] of Object.entries(obj)) {
    if (typeof v === 'string' && v.startsWith('env:')) {
      const varName = v.slice(4);
      out[k] = process.env[varName];
      if (out[k] === undefined) {
        console.warn(`  ! env var ${varName} is not set (referenced by "${k}")`);
      }
    } else if (v && typeof v === 'object') {
      out[k] = resolveSecrets(v);
    } else {
      out[k] = v;
    }
  }
  return out;
}

function validateArea(area) {
  return area && typeof area.id === 'string' && typeof area.name === 'string' &&
    Array.isArray(area.polygon) && area.polygon.length >= 3 && area.schedule;
}

async function main() {
  const args = process.argv.slice(2);
  const configPath = argOrDefault(args, '--config', 'config.json');
  const outOverride = argOrDefault(args, '--out', null);

  const configFull = path.resolve(process.cwd(), configPath);
  if (!fs.existsSync(configFull)) {
    console.error(`Config file not found: ${configFull}`);
    console.error('Copy config.example.json to config.json and edit it, or pass --config <path>.');
    process.exit(1);
  }
  const rawConfig = JSON.parse(fs.readFileSync(configFull, 'utf8'));
  const config = resolveSecrets(rawConfig);

  const outputPath = path.resolve(process.cwd(), outOverride || config.output || 'closures-feed.json');
  const allAreas = [];
  const seenIds = new Set();
  let hadError = false;

  for (const sourceConfig of config.sources || []) {
    const adapterName = sourceConfig.adapter;
    const adapterFn = ADAPTERS[adapterName];
    if (!adapterFn) {
      console.error(`✗ Unknown adapter "${adapterName}" — available: ${Object.keys(ADAPTERS).join(', ')}`);
      hadError = true;
      continue;
    }

    process.stdout.write(`→ ${adapterName}${sourceConfig.label ? ' (' + sourceConfig.label + ')' : ''} ... `);
    try {
      const areas = await adapterFn(sourceConfig);
      let added = 0, skippedDupe = 0, skippedInvalid = 0;
      for (const area of areas) {
        if (!validateArea(area)) { skippedInvalid++; continue; }
        if (seenIds.has(area.id)) { skippedDupe++; continue; }
        seenIds.add(area.id);
        allAreas.push(area);
        added++;
      }
      console.log(`${added} area(s)` +
        (skippedDupe ? `, ${skippedDupe} duplicate id(s) skipped` : '') +
        (skippedInvalid ? `, ${skippedInvalid} invalid record(s) skipped` : ''));
    } catch (err) {
      console.log('FAILED');
      console.error(`  ✗ ${err.message}`);
      hadError = true;
    }
  }

  const feed = {
    format: 'iitc-portal-closures-feed',
    generated: new Date().toISOString(),
    areas: allAreas
  };
  fs.writeFileSync(outputPath, JSON.stringify(feed, null, 2));
  console.log(`\nWrote ${allAreas.length} total area(s) to ${outputPath}`);
  if (hadError) {
    console.log('(completed with errors — see above)');
    process.exitCode = 1;
  }
}

function argOrDefault(args, flag, def) {
  const i = args.indexOf(flag);
  return i !== -1 && args[i + 1] ? args[i + 1] : def;
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
