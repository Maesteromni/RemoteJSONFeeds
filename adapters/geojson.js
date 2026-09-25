'use strict';

const { guessHoursFromFreeText, to24h, DAY_KEYS } = require('../lib/hours');
const { geoJsonGeometryToPolygon, geoJsonGeometryToLine, bufferLineToRibbon } = require('../lib/geometry');

// Generic adapter for ANY source that can hand back GeoJSON with real
// polygon geometry — this is the one to reach for first, since it uses
// the source's actual drawn boundary instead of a point-buffer guess.
// Fits:
//   - ArcGIS REST FeatureServer/MapServer layers: append
//     `?outFields=*&f=geojson` to the layer's query endpoint, e.g.
//     https://services.arcgis.com/XXXX/ArcGIS/rest/services/Parks/FeatureServer/0/query?where=1=1&outFields=*&f=geojson
//   - Socrata open-data portals: most datasets have a "GeoJSON" export
//     link right on the dataset page.
//   - A static .geojson file you host yourself.
//
// config:
//   url          (required) the GeoJSON endpoint/file
//   fieldMap     (required) property-name mapping, see below
//   defaultTimezone (optional) IANA tz used when the source has none
//   idPrefix     (optional) prefix for generated area ids, default "geo"
//   paginate     (optional) set true for ArcGIS sources with more results
//                than one request returns (ArcGIS layers cap out at a
//                maxRecordCount, commonly 1000-2000 — a nationwide/statewide
//                layer filtered down can still easily exceed that). Adds
//                &resultOffset=N&resultRecordCount=pageSize to `url` and
//                loops until a page comes back short. Only meaningful for
//                ArcGIS REST query URLs; harmless (does one request) against
//                a plain static .geojson file or a source that ignores
//                those params, since it stops as soon as a page is short.
//   pageSize     (optional, default 1000) records per page when paginating
//   lineBufferMeters (optional) set this for sources with LineString/
//                MultiLineString geometry (trails, not areas) — buffers
//                the line into a ribbon polygon this many meters wide,
//                same math the IITC plugin itself uses for OSM/GPX
//                trails. Without this, a line-geometry source produces
//                no areas at all (Polygon/MultiPolygon only otherwise).
//
// fieldMap options (all refer to GeoJSON `feature.properties` keys):
//   name           — property holding the area's display name
//   idField        — property holding a stable unique id (falls back to
//                    array index if omitted)
//   hoursText      — a single free-text hours property, run through the
//                    same lightweight parser the other adapters use
//                    (see lib/hours.js: 24/7, closed, dawn-dusk,
//                    sunrise-sunset, "H:MM AM/PM - H:MM AM/PM" daily)
//   perDayFields   — object mapping day keys to {open, close} PROPERTY
//                    NAMES for sources with separate hour columns per day,
//                    e.g. { mon: {open:'MON_OPEN', close:'MON_CLOSE'}, ... }
//                    Values in those columns are expected as "H:MM AM/PM"
//                    or already "HH:MM" 24h strings.
//   timezoneField  — property holding an IANA timezone string, if present
//
// At least one of hoursText / perDayFields should be set, or every area
// will come through with no schedule (still fine — geometry + name only,
// ready for a manual override in the plugin).
async function fetchGeoJsonAreas(config) {
  const { url, fieldMap = {}, defaultTimezone, idPrefix = 'geo', paginate = false, pageSize = 1000, lineBufferMeters = null } = config;
  if (!url) throw new Error('geojson adapter: "url" is required');

  const allFeatures = [];
  if (!paginate) {
    const resp = await fetch(url, { headers: { Accept: 'application/geo+json, application/json' } });
    if (!resp.ok) throw new Error(`geojson adapter: HTTP ${resp.status} fetching ${url}`);
    const geo = await resp.json();
    if (geo.error) throw new Error(`geojson adapter: server rejected the query — ${JSON.stringify(geo.error)}`);
    allFeatures.push(...(geo.features || []));
  } else {
    const sep = url.includes('?') ? '&' : '?';
    let offset = 0;
    for (;;) {
      const pageUrl = `${url}${sep}resultOffset=${offset}&resultRecordCount=${pageSize}`;
      const resp = await fetch(pageUrl, { headers: { Accept: 'application/geo+json, application/json' } });
      if (!resp.ok) throw new Error(`geojson adapter: HTTP ${resp.status} fetching page at offset ${offset}`);
      const geo = await resp.json();
      if (geo.error) throw new Error(`geojson adapter: server rejected the query at offset ${offset} — ${JSON.stringify(geo.error)}`);
      const features = geo.features || [];
      allFeatures.push(...features);
      if (features.length < pageSize) break; // last page
      offset += features.length;
    }
  }

  if (allFeatures.length === 0) {
    console.warn(`  ! geojson adapter: query returned zero raw features (before any geometry/field filtering) — check the "where" clause and field names against the source's own layer definition (append ?f=pjson to the layer URL, without /query, to see them)`);
  }

  const areas = [];
  let droppedNoGeometry = 0;
  allFeatures.forEach((feature, index) => {
    const area = featureToArea(feature, index, fieldMap, defaultTimezone, idPrefix, lineBufferMeters);
    if (area) areas.push(area);
    else droppedNoGeometry++;
  });
  if (droppedNoGeometry) {
    const geomHint = lineBufferMeters ? 'usable Polygon/MultiPolygon/LineString/MultiLineString geometry' : 'usable Polygon/MultiPolygon geometry (set "lineBufferMeters" if this source has trail LINE geometry instead)';
    console.warn(`  ! geojson adapter: ${droppedNoGeometry}/${allFeatures.length} raw feature(s) had no ${geomHint} and were skipped`);
  }
  return areas;
}

function featureToArea(feature, index, fieldMap, defaultTimezone, idPrefix, lineBufferMeters) {
  let polygon = geoJsonGeometryToPolygon(feature.geometry);
  if (!polygon && lineBufferMeters) {
    const line = geoJsonGeometryToLine(feature.geometry);
    if (line && line.length >= 2) polygon = bufferLineToRibbon(line, lineBufferMeters);
  }
  if (!polygon || polygon.length < 3) return null;

  const props = feature.properties || {};
  const name = (fieldMap.name && props[fieldMap.name]) || `Feature ${index}`;
  const id = idPrefix + '-' + ((fieldMap.idField && props[fieldMap.idField]) || index);
  const timezone = (fieldMap.timezoneField && props[fieldMap.timezoneField]) || defaultTimezone || null;

  let schedule = null;
  if (fieldMap.perDayFields) {
    schedule = parsePerDayFields(props, fieldMap.perDayFields);
  }
  if (!schedule && fieldMap.hoursText) {
    schedule = guessHoursFromFreeText(props[fieldMap.hoursText]);
  }
  if (!schedule) {
    schedule = { notes: 'No hours field configured/parseable for this source; geometry and name only.' };
  }
  if (timezone) schedule.timezone = timezone;

  return { id, name, polygon, source: 'GeoJSON: ' + (fieldMap.sourceLabel || 'custom feed'), schedule, updated: null };
}

function normalizeTimeValue(v) {
  if (!v) return null;
  const s = String(v).trim();
  if (/^\d{1,2}:\d{2}$/.test(s)) return s.length === 4 ? '0' + s : s; // already 24h, just zero-pad
  return to24h(s); // try "H:MM AM/PM"
}

function parsePerDayFields(props, perDayFields) {
  const hours = {};
  let parsedAny = false;
  DAY_KEYS.forEach((day) => {
    const fields = perDayFields[day];
    if (!fields) return;
    const open = normalizeTimeValue(props[fields.open]);
    const close = normalizeTimeValue(props[fields.close]);
    if (open && close) { hours[day] = { open, close }; parsedAny = true; }
  });
  return parsedAny ? { hours } : null;
}

module.exports = fetchGeoJsonAreas;
