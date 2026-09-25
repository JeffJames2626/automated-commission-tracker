// The Google services the assistant can use, what each one needs, and — in
// plain words — exactly what it can and cannot do. The Connections screen
// renders this verbatim so permissions are never a mystery.
//
// Scopes verified against Google's discovery documents (gmail v1, calendar v3,
// drive v3, sheets v4, people v1). All are read-only.

export const SIGN_IN_SCOPES = ['openid', 'email', 'profile'];

export const SERVICES = {
  gmail: {
    label: 'Gmail',
    icon: 'mail',
    provider: 'google_gmail',
    scopes: ['https://www.googleapis.com/auth/gmail.readonly'],
    can: ['Search your email', 'Read threads and list attachments', 'Summarize conversations and find what is waiting on you'],
    cannot: ['Send, delete, archive or label email', 'Change settings'],
  },
  calendar: {
    label: 'Calendar',
    icon: 'calendar',
    provider: 'google_calendar',
    scopes: [
      'https://www.googleapis.com/auth/calendar.events.readonly',
      'https://www.googleapis.com/auth/calendar.calendarlist.readonly',
    ],
    can: ['See your calendars and events', 'Understand today, tomorrow and this week'],
    cannot: ['Create, change or delete events', 'Respond to invitations'],
  },
  drive: {
    label: 'Drive & Docs',
    icon: 'folder',
    provider: 'google_drive',
    scopes: ['https://www.googleapis.com/auth/drive.readonly'],
    can: ['Search files by name and content', 'Read Google Docs, text files and PDFs'],
    cannot: ['Create, edit, move, share or delete files'],
  },
  sheets: {
    label: 'Sheets',
    icon: 'table',
    provider: 'google_sheets',
    scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
    can: ['List tabs, headers and tables', 'Read cell values and formulas'],
    cannot: ['Edit any cell, tab or spreadsheet'],
    note: 'Finding a spreadsheet by meaning uses Drive search; with Drive off, paste a Sheet link.',
  },
  contacts: {
    label: 'Contacts',
    icon: 'person',
    provider: 'google_contacts',
    scopes: ['https://www.googleapis.com/auth/contacts.readonly'],
    can: ['Look up names, emails, companies and phone numbers'],
    cannot: ['Add, edit or delete contacts'],
  },
};

export const SERVICE_KEYS = Object.keys(SERVICES);

// A service is usable when Google actually granted every scope it needs (the
// consent screen lets people untick boxes) and the user has not switched it off.
export function serviceState(conn, key) {
  const svc = SERVICES[key];
  if (!conn) return 'not_connected';
  const granted = new Set(conn.granted_scopes || []);
  if (!svc.scopes.every(s => granted.has(s))) return 'not_granted';
  if ((conn.disabled_services || []).includes(key)) return 'disabled';
  if (conn.status === 'revoked') return 'reconnect';
  if (conn.status === 'expired') return 'reconnect';
  return 'connected';
}

export function scopesFor(keys) {
  const out = new Set(SIGN_IN_SCOPES);
  keys.forEach(k => (SERVICES[k] ? SERVICES[k].scopes : []).forEach(s => out.add(s)));
  return [...out];
}
