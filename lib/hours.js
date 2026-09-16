'use strict';

// Shared helpers for turning whatever hours format a source gives us into
// the schedule shape the IITC plugin expects:
//
//   schedule.hours = {
//     mon: {open:'HH:MM', close:'HH:MM'} | false | 'allday' | {solar:'sunrise-sunset'|'dawn-dusk'},
//     tue: ..., wed: ..., thu: ..., fri: ..., sat: ..., sun: ...
//   }
//
// Every function here is defensive: if it can't confidently parse
// something, it returns null/undefined rather than guessing — a missing
// schedule is honest, a wrong one is actively misleading.

const DAY_KEYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

function pad2(n) {
  return String(n).padStart(2, '0');
}

// "6:00 AM" / "6:00AM" / "10:00 PM" / "12:00 PM" -> "06:00" / "22:00" / "12:00"
function to24h(text) {
  if (!text) return null;
  const m = String(text).trim().match(/^(\d{1,2}):(\d{2})\s*([AaPp][Mm])$/);
  if (!m) return null;
  let h = parseInt(m[1], 10);
  const min = m[2];
  const isPM = /p/i.test(m[3]);
  if (h === 12) h = 0;
  if (isPM) h += 12;
  return pad2(h) + ':' + min;
}

// Recognizes a handful of common free-text hours phrasings. Returns
// { hours } | { closed:true } | null (null = leave it to the caller to
// decide what to do, e.g. keep the raw text in notes without a schedule).
function guessHoursFromFreeText(text) {
  if (!text) return null;
  const t = String(text).trim();

  if (/^(24\s*hours?|24\/7|open\s*24\s*hours?)$/i.test(t)) {
    const hours = {};
    DAY_KEYS.forEach((d) => { hours[d] = 'allday'; });
    return { hours };
  }
  if (/^(closed|no public access|not accessible)$/i.test(t)) {
    return { closed: true };
  }
  if (/dawn/i.test(t) && /dusk/i.test(t)) {
    const hours = {};
    DAY_KEYS.forEach((d) => { hours[d] = { solar: 'dawn-dusk' }; });
    return { hours };
  }
  if (/sunrise/i.test(t) && /sunset/i.test(t)) {
    const hours = {};
    DAY_KEYS.forEach((d) => { hours[d] = { solar: 'sunrise-sunset' }; });
    return { hours };
  }

  // "6:00 AM - 10:00 PM" / "6:00AM to 10:00PM", applied to every day.
  // Matches a single daily range; doesn't attempt per-weekday free text
  // (that's wildly inconsistent across sources — leave it to a
  // source-specific adapter, or to a manual override, rather than
  // mis-parsing it here).
  const range = t.match(/(\d{1,2}:\d{2}\s*[AaPp][Mm])\s*(?:-|to|–|—)\s*(\d{1,2}:\d{2}\s*[AaPp][Mm])/);
  if (range) {
    const open = to24h(range[1]);
    const close = to24h(range[2]);
    if (open && close) {
      const hours = {};
      DAY_KEYS.forEach((d) => { hours[d] = { open, close }; });
      return { hours };
    }
  }

  return null;
}

// NPS `operatingHours[].standardHours` shape:
//   { monday: "6:00AM - 10:00PM", tuesday: "6:00AM - 10:00PM", ... }
// Values are sometimes "Sunrise-Sunset", "All Day", "Closed", or blank.
function parseNpsStandardHours(standardHours) {
  if (!standardHours || typeof standardHours !== 'object') return null;
  const dayMap = {
    sunday: 'sun', monday: 'mon', tuesday: 'tue', wednesday: 'wed',
    thursday: 'thu', friday: 'fri', saturday: 'sat'
  };
  const hours = {};
  let parsedAny = false;

  for (const longDay of Object.keys(dayMap)) {
    const shortDay = dayMap[longDay];
    const raw = (standardHours[longDay] || '').trim();
    if (!raw) continue;

    if (/^closed$/i.test(raw)) { hours[shortDay] = false; parsedAny = true; continue; }
    if (/^(all day|24 hours)$/i.test(raw)) { hours[shortDay] = 'allday'; parsedAny = true; continue; }
    if (/sunrise/i.test(raw) && /sunset/i.test(raw)) { hours[shortDay] = { solar: 'sunrise-sunset' }; parsedAny = true; continue; }
    if (/dawn/i.test(raw) && /dusk/i.test(raw)) { hours[shortDay] = { solar: 'dawn-dusk' }; parsedAny = true; continue; }

    const m = raw.match(/(\d{1,2}:\d{2}\s*[AaPp][Mm])\s*-\s*(\d{1,2}:\d{2}\s*[AaPp][Mm])/);
    if (m) {
      const open = to24h(m[1]);
      const close = to24h(m[2]);
      if (open && close) { hours[shortDay] = { open, close }; parsedAny = true; }
    }
    // anything else (blank, odd phrasing) is left unset for that day
    // rather than guessed at.
  }

  return parsedAny ? { hours } : null;
}

module.exports = { DAY_KEYS, to24h, guessHoursFromFreeText, parseNpsStandardHours };
