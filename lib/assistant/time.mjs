// Time-zone math without a date library. "Today" and "tomorrow at 9" mean the
// owner's local day, not the server's UTC day.

export function validTz(tz) {
  try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return true; } catch { return false; }
}

function parts(ms, tz) {
  const f = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', weekday: 'short' });
  const o = {};
  f.formatToParts(new Date(ms)).forEach(p => { o[p.type] = p.value; });
  return { y: +o.year, m: +o.month, d: +o.day, h: +o.hour, min: +o.minute, s: +o.second, wd: o.weekday };
}

// Offset (ms) of tz from UTC at instant `ms`.
export function tzOffset(ms, tz) {
  const p = parts(ms, tz);
  return Date.UTC(p.y, p.m - 1, p.d, p.h, p.min, p.s) - Math.floor(ms / 1000) * 1000;
}

// Local wall-clock time in tz → UTC instant.
export function zonedToUtc(y, m, d, h = 0, min = 0, tz = 'UTC') {
  const guess = Date.UTC(y, m - 1, d, h, min);
  const off1 = tzOffset(guess - tzOffset(guess, tz), tz);
  return new Date(guess - off1);
}

export function localDate(ms, tz) {
  const p = parts(ms, tz);
  return { y: p.y, m: p.m, d: p.d, weekday: p.wd, h: p.h };
}

export function dayBounds(ms, tz, addDays = 0) {
  const p = parts(ms, tz);
  const start = zonedToUtc(p.y, p.m, p.d + addDays, 0, 0, tz);
  const end = zonedToUtc(p.y, p.m, p.d + addDays + 1, 0, 0, tz);
  return { start, end };
}

export function describeNow(ms, tz) {
  const f = new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  return f.format(new Date(ms)) + ' (' + tz + ')';
}

const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

// Plain-language due dates for the offline classifier: today, tonight,
// tomorrow, "on friday", "next week". Returns null when nothing is said.
export function parseDue(text, nowMs, tz) {
  const t = String(text || '').toLowerCase();
  const p = parts(nowMs, tz);
  const at = (addDays, hour) => zonedToUtc(p.y, p.m, p.d + addDays, hour, 0, tz);
  const hourMatch = t.match(/\b(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/);
  let hour = null;
  if (hourMatch) { hour = (+hourMatch[1] % 12) + (hourMatch[3] === 'pm' ? 12 : 0); }
  const withHour = (addDays, dflt) => {
    const d = at(addDays, hour ?? dflt);
    if (hourMatch && hourMatch[2]) d.setUTCMinutes(d.getUTCMinutes() + +hourMatch[2]);
    return d;
  };
  if (/\btonight\b/.test(t)) return withHour(0, 19);
  if (/\btoday\b/.test(t)) return withHour(0, hour ?? Math.min(23, p.h + 2));
  if (/\btomorrow\b/.test(t)) return withHour(1, 9);
  const today = WEEKDAYS.findIndex(w => w.startsWith(p.wd.toLowerCase().slice(0, 3)));
  if (/\bnext week\b/.test(t)) return withHour(((1 - today + 7) % 7) || 7, 9);   // next Monday
  const wd = t.match(/\b(?:on |this |next )?(sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b/);
  if (wd) {
    let add = (WEEKDAYS.indexOf(wd[1]) - today + 7) % 7;
    if (add === 0) add = 7;
    return withHour(add, 9);
  }
  if (hourMatch) return withHour(0, hour);
  return null;
}
