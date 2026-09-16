'use strict';

const { parseNpsStandardHours } = require('../lib/hours');
const { pointBuffer, geoJsonGeometryToPolygon } = require('../lib/geometry');

// NPS Data API (https://developer.nps.gov) — free, instant API key at
// https://www.nps.gov/subjects/developer/get-started.htm. Covers all NPS
// units (national parks, monuments, historic sites, etc.) with structured
// `operatingHours`.
//
// The NPS API itself only gives a park's centroid point, not its real
// boundary. To get real footprints, this adapter separately queries an
// ArcGIS "NPS boundary" layer (several near-identical public mirrors of
// the same underlying NPS Land Resources Division dataset exist; the
// default below is one such mirror — override `boundaryServiceUrl` if you
// have a preferred/more authoritative one) and matches each park by its
// UNIT_CODE. Parks with no boundary match (or if the boundary fetch fails
// entirely) fall back to the circular point-buffer approximation used
// before, so this degrades gracefully rather than losing the park.
//
// config:
//   apiKey             (required) NPS API key
//   stateCode          (optional) e.g. "CA" — omit for all states
//   parkCode           (optional) e.g. "yose" — omit for all parks matching stateCode
//   bufferRadiusMeters (optional, default 800) fallback radius when no real boundary is found
//   useBoundaries      (optional, default true) set false to skip the boundary lookup entirely
//   boundaryServiceUrl (optional) ArcGIS FeatureServer layer query URL for NPS boundaries;
//                       defaults to a public mirror of the NPS Land Resources Division dataset
async function fetchNpsAreas(config) {
  const {
    apiKey, stateCode, parkCode, bufferRadiusMeters = 800,
    useBoundaries = true,
    boundaryServiceUrl = 'https://services1.arcgis.com/KNdRU5cN6ENqCTjk/ArcGIS/rest/services/nps_boundary/FeatureServer/0'
  } = config;
  if (!apiKey) {
    throw new Error('nps adapter: "apiKey" is required (free key: https://www.nps.gov/subjects/developer/get-started.htm)');
  }

  const boundaries = useBoundaries
    ? await fetchBoundaryMap(boundaryServiceUrl, stateCode).catch((err) => {
      console.warn(`  ! nps adapter: boundary lookup failed, falling back to circular buffers for all parks — ${err.message}`);
      return {};
    })
    : {};

  const areas = [];
  let start = 0;
  const limit = 50;
  let boundaryMatches = 0;

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
      const boundaryPolygon = boundaries[(park.parkCode || '').toUpperCase()];
      if (boundaryPolygon) boundaryMatches++;
      const area = parkToArea(park, bufferRadiusMeters, boundaryPolygon);
      if (area) areas.push(area);
    }

    start += parks.length;
    if (parks.length === 0 || start >= Number(data.total || 0)) break;
  }

  console.log(`  (nps adapter: ${boundaryMatches}/${areas.length} area(s) got a real boundary; the rest fell back to a circular approximation)`);
  return areas;
}

// Fetches the boundary layer (optionally filtered by STATE) and returns a
// map of UNIT_CODE -> polygon. Paginates defensively past the layer's
// per-request record cap.
async function fetchBoundaryMap(serviceUrl, stateCode) {
  const map = {};
  let offset = 0;
  const pageSize = 2000;

  for (;;) {
    const params = new URLSearchParams({
      outFields: 'UNIT_CODE,UNIT_NAME',
      f: 'geojson',
      resultRecordCount: String(pageSize),
      resultOffset: String(offset),
      where: stateCode ? `STATE='${stateCode.replace(/'/g, "''")}'` : '1=1'
    });
    const resp = await fetch(`${serviceUrl}/query?${params}`);
    if (!resp.ok) throw new Error(`HTTP ${resp.status} fetching boundary layer`);
    const geo = await resp.json();
    const features = geo.features || [];

    for (const feature of features) {
      const code = (feature.properties && feature.properties.UNIT_CODE || '').toUpperCase();
      if (!code) continue;
      const polygon = geoJsonGeometryToPolygon(feature.geometry);
      if (polygon && polygon.length >= 3) map[code] = polygon;
    }

    offset += features.length;
    if (features.length < pageSize) break; // last page
  }

  return map;
}

function parkToArea(park, bufferRadiusMeters, boundaryPolygon) {
  const lat = parseFloat(park.latitude);
  const lng = parseFloat(park.longitude);
  const hasBoundary = !!boundaryPolygon;
  if (!hasBoundary && (!Number.isFinite(lat) || !Number.isFinite(lng))) return null;

  const entry = (park.operatingHours || [])[0];
  const parsed = entry ? parseNpsStandardHours(entry.standardHours) : null;

  const exceptionNote = entry && entry.exceptions && entry.exceptions.length
    ? ' Exceptions apply (holidays/seasonal) — check nps.gov for details.'
    : '';

  return {
    id: 'nps-' + park.parkCode,
    name: park.fullName || park.name,
    polygon: hasBoundary ? boundaryPolygon : pointBuffer(lat, lng, bufferRadiusMeters),
    source: hasBoundary
      ? 'NPS (nps.gov) — real park boundary'
      : 'NPS (nps.gov) — approximate circular boundary, not the real park footprint',
    schedule: parsed
      ? { hours: parsed.hours, notes: (entry.description || '').trim() + exceptionNote }
      : { notes: 'NPS did not provide structured standard hours for this park.' + exceptionNote },
    updated: null
  };
}

module.exports = fetchNpsAreas;
