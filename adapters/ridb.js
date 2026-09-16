'use strict';

const { guessHoursFromFreeText } = require('../lib/hours');
const { pointBuffer } = require('../lib/geometry');

// RIDB / Recreation.gov Facilities API (https://ridb.recreation.gov) —
// covers USFS, BLM, Army Corps, Bureau of Reclamation, and Fish & Wildlife
// Service facilities (trailheads, campgrounds, rec areas) in addition to
// some NPS overlap. Usable anonymously at low rate limits; a free API key
// (https://ridb.recreation.gov) raises the limit.
//
// IMPORTANT LIMITATION: unlike the NPS API, RIDB facility records don't
// reliably expose a structured open/close-hours field — hours, where they
// exist at all, tend to be buried in free-text `FacilityDescription` or
// `FacilityTypeDescription` copy, not a clean schema. This adapter makes a
// best-effort scan of that text for recognizable phrasing (see
// lib/hours.js) and otherwise adds the area WITHOUT a schedule — geometry
// and name only, with the raw description kept in notes so you can review
// it and add a manual override in the plugin if needed. Don't expect this
// adapter alone to give you closure-time coverage the way the NPS one can.
//
// config:
//   apiKey          (optional) RIDB API key — raises rate limits
//   state           (optional) two-letter state code, e.g. "CA"
//   activity        (optional) activity name filter, e.g. "Hiking"
//   query           (optional) free-text keyword filter
//   bufferRadiusMeters (optional, default 300)
async function fetchRidbAreas(config) {
  const { apiKey, state, activity, query, bufferRadiusMeters = 300 } = config;

  const areas = [];
  let offset = 0;
  const limit = 50;

  for (;;) {
    const params = new URLSearchParams({ limit: String(limit), offset: String(offset) });
    if (state) params.set('state', state);
    if (activity) params.set('activity', activity);
    if (query) params.set('query', query);

    const headers = { Accept: 'application/json' };
    if (apiKey) headers.apikey = apiKey;

    const resp = await fetch(`https://ridb.recreation.gov/api/v1/facilities?${params}`, { headers });
    if (!resp.ok) throw new Error(`ridb adapter: HTTP ${resp.status} fetching facilities`);
    const data = await resp.json();
    const facilities = (data.RECDATA || []);

    for (const facility of facilities) {
      const area = facilityToArea(facility, bufferRadiusMeters);
      if (area) areas.push(area);
    }

    offset += facilities.length;
    const total = data.METADATA && data.METADATA.RESULTS ? Number(data.METADATA.RESULTS.TOTAL_COUNT) : 0;
    if (facilities.length === 0 || offset >= total) break;
  }

  return areas;
}

function facilityToArea(facility, bufferRadiusMeters) {
  const lat = parseFloat(facility.FacilityLatitude);
  const lng = parseFloat(facility.FacilityLongitude);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;

  const freeText = [facility.FacilityDescription, facility.FacilityTypeDescription]
    .filter(Boolean).join(' ');
  const guessed = guessHoursFromFreeText(freeText);

  return {
    id: 'ridb-' + facility.FacilityID,
    name: facility.FacilityName,
    polygon: pointBuffer(lat, lng, bufferRadiusMeters),
    source: 'RIDB (recreation.gov) — approximate circular boundary, hours often unavailable',
    schedule: guessed
      ? guessed
      : { notes: 'RIDB gave no reliably parseable hours for this facility.' +
          (freeText ? ' Raw description: "' + freeText.slice(0, 200) + '"' : '') },
    updated: null
  };
}

module.exports = fetchRidbAreas;
