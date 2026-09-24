// Every external source the assistant knows about. Google is the only live
// provider in V1; the others are declared so the Connections screen and the
// data model already have a place for them. Adding one means writing an
// adapter under integrations/<provider>/ that returns SourceItems — nothing in
// the UI or the assistant needs to learn a new shape.
//
// SourceItem = { provider, kind, recordId, title, snippet, url, date, meta }

import { SERVICES } from './google/services.mjs';

export const PROVIDERS = [
  { id: 'google', label: 'Google Workspace', status: 'available', services: Object.keys(SERVICES) },
  { id: 'alp_sales_tracker', label: 'ALP Sales Tracker', status: 'planned' },
  { id: 'service_autopilot', label: 'Service Autopilot', status: 'planned' },
  { id: 'ringcentral', label: 'RingCentral', status: 'planned' },
  { id: 'github', label: 'GitHub', status: 'planned' },
  { id: 'vercel', label: 'Vercel', status: 'planned' },
];

// Human label for a SourceItem provider, used on every citation chip so it is
// never unclear where information came from.
export const SOURCE_LABEL = {
  notes: 'My notes',
  memory: 'Memory',
  google_gmail: 'Email',
  google_calendar: 'Calendar',
  google_drive: 'Drive',
  google_sheets: 'Sheets',
  google_contacts: 'Contacts',
};
