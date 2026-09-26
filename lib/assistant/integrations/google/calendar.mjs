import { clip } from '../../text.mjs';

// Google Calendar adapter (read-only). Calendar API v3: calendarList.list,
// events.list with singleEvents=true so recurring meetings come back as the
// concrete instances a person actually has on a given day.

const BASE = 'https://www.googleapis.com/calendar/v3';

export function mapEvent(ev, calendar) {
  const allDay = !!(ev.start && ev.start.date && !ev.start.dateTime);
  const start = ev.start ? (ev.start.dateTime || ev.start.date) : null;
  const end = ev.end ? (ev.end.dateTime || ev.end.date) : null;
  const attendees = (ev.attendees || []).filter(a => !a.resource).map(a => ({
    email: String(a.email || '').toLowerCase(), name: a.displayName || '', response: a.responseStatus || '', self: !!a.self, organizer: !!a.organizer,
  }));
  const me = attendees.find(a => a.self);
  return {
    provider: 'google_calendar',
    kind: 'event',
    // An instance id is unique within its calendar; qualify it so two
    // calendars can never collide in our external-record table.
    recordId: (calendar && calendar.id ? calendar.id : 'primary') + '/' + ev.id,
    title: ev.summary || '(no title)',
    snippet: clip([ev.location, (ev.description || '').replace(/<[^>]+>/g, ' ')].filter(Boolean).join(' — ').replace(/\s+/g, ' '), 240),
    url: ev.htmlLink || null,
    date: start,
    meta: {
      start, end, allDay,
      timeZone: ev.start && ev.start.timeZone || null,
      location: ev.location || '',
      calendar: calendar ? (calendar.summaryOverride || calendar.summary || calendar.id) : 'primary',
      attendees: attendees.slice(0, 25),
      attendeeCount: attendees.length,
      organizer: ev.organizer ? (ev.organizer.displayName || ev.organizer.email || '') : '',
      myResponse: me ? me.response : '',
      meetLink: ev.hangoutLink || null,
      recurring: !!ev.recurringEventId,
    },
  };
}

export async function listCalendars(client) {
  const r = await client.paginate(BASE + '/users/me/calendarList', { itemsKey: 'items', maxItems: 50, pageSizeParam: 'maxResults', pageSize: 50 });
  return r.items.filter(c => !c.deleted && !c.hidden);
}

// Events overlapping [timeMin, timeMax) across the calendars the person shows
// in Google Calendar (selected), capped so a busy shared calendar cannot
// swamp the answer. Declined events are dropped.
export async function listEvents(client, { timeMin, timeMax, query, max = 60, maxCalendars = 6 }) {
  let cals;
  try { cals = (await listCalendars(client)).filter(c => c.selected || c.primary); }
  catch { cals = [{ id: 'primary', summary: 'Calendar', primary: true }]; }
  cals.sort((a, b) => (b.primary ? 1 : 0) - (a.primary ? 1 : 0));
  cals = cals.slice(0, maxCalendars);
  const errors = [];
  const perCal = await Promise.all(cals.map(async cal => {
    try {
      const r = await client.paginate(BASE + '/calendars/' + encodeURIComponent(cal.id) + '/events', {
        params: { timeMin, timeMax, q: query || undefined, singleEvents: true, orderBy: 'startTime', maxAttendees: 25 },
        itemsKey: 'items', maxItems: max, pageSizeParam: 'maxResults', pageSize: Math.min(max, 250),
      });
      return r.items.filter(e => e.status !== 'cancelled').map(e => mapEvent(e, cal));
    } catch (e) { errors.push({ calendar: cal.summary || cal.id, error: e.kind || 'failed' }); return []; }
  }));
  const items = perCal.flat()
    .filter(e => e.meta.myResponse !== 'declined')
    .sort((a, b) => (Date.parse(a.meta.start) || 0) - (Date.parse(b.meta.start) || 0))
    .slice(0, max);
  if (!items.length && errors.length === cals.length && errors.length) {
    const e = new Error('calendar unavailable'); e.kind = errors[0].error; throw e;
  }
  return { items, errors };
}
