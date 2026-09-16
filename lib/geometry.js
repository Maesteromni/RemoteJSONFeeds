'use strict';

// Many "public data" sources (NPS, RIDB) only give a single lat/lng point
// for a facility, not its actual boundary. For a point-in-polygon check to
// work at all, we approximate a circle of `radiusMeters` around the point.
// This is clearly NOT the real park boundary — it's a stand-in so the area
// shows up on the map and can be refined manually. Sources that provide
// real polygons (most city/county GIS portals) should always be preferred
// over this when available; see adapters/geojson.js.
function pointBuffer(lat, lng, radiusMeters, sides = 16) {
  const points = [];
  const earthRadius = 6371000;
  const latRad = (lat * Math.PI) / 180;
  for (let i = 0; i < sides; i++) {
    const angle = (2 * Math.PI * i) / sides;
    const dLat = (radiusMeters * Math.cos(angle)) / earthRadius;
    const dLng = (radiusMeters * Math.sin(angle)) / (earthRadius * Math.cos(latRad));
    points.push([
      lat + (dLat * 180) / Math.PI,
      lng + (dLng * 180) / Math.PI
    ]);
  }
  return points;
}

// Pulls a single outer ring of [lat,lng] pairs out of a GeoJSON geometry.
// Polygon -> first ring (outer boundary). MultiPolygon -> the largest
// polygon's outer ring (by point count, a cheap proxy for "main body" —
// good enough to pick the primary shape over small disconnected slivers).
// GeoJSON coordinates are [lng,lat]; we flip to [lat,lng] to match the
// plugin's convention.
function geoJsonGeometryToPolygon(geometry) {
  if (!geometry) return null;
  if (geometry.type === 'Polygon' && geometry.coordinates && geometry.coordinates[0]) {
    return geometry.coordinates[0].map(([lng, lat]) => [lat, lng]);
  }
  if (geometry.type === 'MultiPolygon' && geometry.coordinates) {
    let best = null;
    for (const poly of geometry.coordinates) {
      const ring = poly && poly[0];
      if (ring && (!best || ring.length > best.length)) best = ring;
    }
    return best ? best.map(([lng, lat]) => [lat, lng]) : null;
  }
  return null;
}

module.exports = { pointBuffer, geoJsonGeometryToPolygon };
