# Portal Closures Adapter

A small, source-agnostic Node.js tool that pulls public-access-hours data
from various APIs/open-data portals, normalizes it into one schema, and
writes a single JSON file. Host that file anywhere (GitHub Pages, a Gist's
raw URL, S3, your own server) and add its URL as a remote feed in the IITC
"Portal Closure Times" plugin (Closures → add a remote JSON feed).

This runs standalone, outside the browser — no CORS/CSP headaches, no
GM_xmlhttpRequest tricks, just a scheduled script (cron, GitHub Actions,
whatever) that keeps a static file fresh.

## Quick start

```bash
node --version   # need 18+ (uses the built-in global fetch)
cp config.example.json config.json
# edit config.json — set which sources you want, get API keys below
export NPS_API_KEY=xxxx     # if using the nps adapter
export RIDB_API_KEY=xxxx    # optional, raises RIDB rate limits
node index.js --config config.json
# -> writes closures-feed.json
```

Then in the plugin: **Closures → add a remote JSON feed → paste the URL**
where you're hosting `closures-feed.json`.

## Built-in adapters

| Adapter   | Source                          | Geometry                      | Hours coverage |
|-----------|----------------------------------|--------------------------------|-----------------|
| `nps`     | National Park Service (developer.nps.gov) | Circular buffer around a point (NPS gives no boundary) | Good — structured per-day hours |
| `ridb`    | Recreation.gov / RIDB (USFS, BLM, Army Corps, etc.) | Circular buffer around a point | Weak — best-effort free-text scan only; most facilities will have no schedule |
| `geojson` | **Any** source that can return GeoJSON — ArcGIS REST FeatureServer/MapServer layers, Socrata open-data exports, or a static `.geojson` file | **Real polygon**, taken straight from the source | Depends entirely on the source; configurable field mapping |

**Prefer `geojson` whenever the source has one** — it's the only adapter
using the source's actual drawn boundary instead of a guessed circle.
Most city/county/regional park districts publish exactly this kind of
layer even when they don't have a documented "API" — check for an ArcGIS
Online item or a Socrata dataset page with a GeoJSON export link.

### Getting API keys
- NPS: instant, free, just an email — https://www.nps.gov/subjects/developer/get-started.htm
- RIDB: free, optional (raises anonymous rate limits) — https://ridb.recreation.gov

### Config reference

See `config.example.json`. Every entry in `sources` needs an `adapter`
name matching one of the registry keys in `index.js`, plus whatever that
adapter's own config fields are (documented in a comment at the top of
each file in `adapters/`). Any string value written as `"env:SOME_VAR"`
is pulled from the environment instead of the file — use this for API
keys so you're not committing secrets into `config.json`.

## Adding a new source

An adapter is just a function with this signature:

```js
// adapters/my-source.js
async function fetchMySourceAreas(sourceConfig) {
  // ... fetch + transform ...
  return [
    {
      id: 'my-source-unique-id',      // stable, prefixed so it can't collide with other adapters
      name: 'Display Name',
      polygon: [[lat, lng], [lat, lng], [lat, lng], ...], // closed ring, 3+ points
      source: 'My Source (mysite.org)',
      schedule: {
        // one of:
        closed: true,
        // or
        hours: {
          mon: { open: '06:00', close: '20:00' }, // fixed hours
          tue: false,                              // closed that day
          wed: 'allday',                           // open 24h
          thu: { solar: 'sunrise-sunset' },        // resolved daily by the plugin
          // fri/sat/sun omitted = closed (no data)
        },
        timezone: 'America/Los_Angeles', // optional, IANA name
        notes: 'Free text shown to the user'
      },
      updated: null // optional ISO date string
    }
  ];
}
module.exports = fetchMySourceAreas;
```

Register it in `index.js`:

```js
const ADAPTERS = {
  nps: require('./adapters/nps'),
  ridb: require('./adapters/ridb'),
  geojson: require('./adapters/geojson'),
  'my-source': require('./adapters/my-source'), // add this line
};
```

Then reference `"adapter": "my-source"` in `config.json`. `lib/hours.js`
and `lib/geometry.js` have reusable helpers (free-text hours parsing,
point-buffer polygons, GeoJSON ring extraction) if your source needs them.

## Known limitations

- **Point-only sources (`nps`, `ridb`) get a fake circular boundary**,
  sized by `bufferRadiusMeters` in that source's config. This is a stand-in
  for a real polygon, not an accurate footprint — a small urban park and a
  sprawling national forest both just become "a circle around one point."
  Use the `geojson` adapter (or a manual area in the plugin) wherever
  boundary accuracy actually matters.
- **RIDB rarely has structured hours.** The `ridb` adapter will add most
  areas with geometry + name only, no schedule, and the raw facility
  description in `notes` for manual review.
- **Free-text hours parsing is intentionally conservative.** Anything that
  doesn't match a recognized pattern (24/7, closed, dawn-dusk,
  sunrise-sunset, a single daily "H:MM AM/PM - H:MM AM/PM" range) is left
  unset rather than guessed at — check `notes` on the resulting area and
  add a manual override in the plugin if the source's phrasing wasn't
  recognized.
- **Duplicate `id`s across sources are dropped** (first source wins) —
  give adapters distinct id prefixes to avoid unintentional collisions.

## Scheduling

This is just a script — run it however you'd run any scheduled job:
a cron entry, a GitHub Actions workflow on a schedule that commits
`closures-feed.json` to a repo (then point the plugin at the raw file
URL), etc. The plugin re-fetches its remote feeds periodically on its own
(configurable interval, default 30 min) and on manual refresh, so keeping
this output reasonably fresh is all that's needed on this side.
