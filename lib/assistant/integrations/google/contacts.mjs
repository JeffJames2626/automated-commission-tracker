// Google Contacts adapter (read-only). People API v1: people:searchContacts.
// Google asks clients to send one empty-query "warmup" request before real
// searches so the cache is populated; we do it once per warm instance.

const BASE = 'https://people.googleapis.com/v1';
const READ_MASK = 'names,emailAddresses,organizations,phoneNumbers';
let warmed = false;

export function mapPerson(p) {
  const name = (p.names && p.names[0] && p.names[0].displayName) || '';
  const emails = (p.emailAddresses || []).map(e => String(e.value || '').toLowerCase()).filter(Boolean);
  const org = p.organizations && p.organizations[0] ? p.organizations[0] : null;
  const id = String(p.resourceName || '').replace(/^people\//, '');
  return {
    provider: 'google_contacts',
    kind: 'contact',
    recordId: p.resourceName,                       // stable provider id, e.g. people/c123
    title: name || emails[0] || '(no name)',
    snippet: [org && org.title, org && org.name, emails[0]].filter(Boolean).join(' · '),
    url: id ? 'https://contacts.google.com/person/' + encodeURIComponent(id) : null,
    date: null,
    meta: {
      emails,
      phones: (p.phoneNumbers || []).map(x => x.value).filter(Boolean).slice(0, 4),
      company: org ? org.name || '' : '',
      jobTitle: org ? org.title || '' : '',
    },
  };
}

export async function searchContacts(client, { query, max = 10 }) {
  if (!warmed) {
    try { await client.get(BASE + '/people:searchContacts', { query: '', readMask: READ_MASK }); } catch { /* best effort */ }
    warmed = true;
  }
  const r = await client.get(BASE + '/people:searchContacts', { query: String(query || '').slice(0, 100), readMask: READ_MASK, pageSize: Math.min(max, 30) });
  return { items: (r.results || []).map(x => mapPerson(x.person || {})) };
}

export function _resetWarmup() { warmed = false; }
