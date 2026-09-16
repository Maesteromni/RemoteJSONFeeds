'use strict';

const { parseNpsStandardHours } = require('../lib/hours');
const { pointBuffer } = require('../lib/geometry');

// NPS Data API (https://developer.nps.gov) — free, instant API key at
// https://www.nps.gov/subjects/developer/get-started.htm. Covers all NPS
// units (national parks, monuments, historic sites, etc.) with structured
// `operatingHours`. NPS only gives a park's centroid point, not its real
// boundary, so geometry here is a circular approximation — refine with a
// manual area in the plugin, or a GeoJSON source (see adapters/geojson.js),
// if you need the real footprint.
//
// config:
//   apiKey          (required) NPS API key
//   stateCode       (optional) e.g. "CA" — omit for all states
//   parkCode        (optional) e.g. "yose" — omit for all parks matching stateCode
//   bufferRadiusMeters (optional, default 800) radius for the point-buffer polygon
async function fetchNpsAreas(config) {
  const { apiKey, stateCode, parkCode, bufferRadiusMeters = 800 } = config;
  if (!apiKey) {
    throw new Error('nps adapter: "apiKey" is required (free key: https://www.nps.gov/subjects/developer/get-started.htm)');
  }

  const areas = [];
  let start = 0;
  const limit = 50;

  for (;;) {
    const params = new URLSearchParams({ start: String(start), limit: String(limit) });
    if (stateCode) params.set('stateCode', stateCode);
    if (parkCode) params.set('parkCode', parkCode);

    const resp = await fetch(`https://developer.nps.gov/api/v1/parks?${params}`, {
      headers: { 'X-Api-Key': apiKey, Accept: 'application/json' }
    });
    if (!resp.ok) throw new Error(`nps adapter: HTTP ${resp.status} fetching parks`);
    const data = await resp.json();
    const parks = data.data || [];

    for (const park of parks) {
      const area = parkToArea(park, bufferRadiusMeters);
      if (area) areas.push(area);
    }

    start += parks.length;
    if (parks.length === 0 || start >= Number(data.total || 0)) break;
  }

  return areas;
}

function parkToArea(park, bufferRadiusMeters) {
  const lat = parseFloat(park.latitude);
  const lng = parseFloat(park.longitude);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;

  const entry = (park.operatingHours || [])[0];
  const parsed = entry ? parseNpsStandardHours(entry.standardHours) : null;

  const exceptionNote = entry && entry.exceptions && entry.exceptions.length
    ? ' Exceptions apply (holidays/seasonal) — check nps.gov for details.'
    : '';

  return {
    id: 'nps-' + park.parkCode,
    name: park.fullName || park.name,
    polygon: pointBuffer(lat, lng, bufferRadiusMeters),
    source: 'NPS (nps.gov) — approximate circular boundary, not the real park footprint',
    schedule: parsed
      ? { hours: parsed.hours, notes: (entry.description || '').trim() + exceptionNote }
      : { notes: 'NPS did not provide structured standard hours for this park.' + exceptionNote },
    updated: null
  };
}

module.exports = fetchNpsAreas;
