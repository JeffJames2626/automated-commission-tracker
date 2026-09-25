// Every source the assistant can use, and exactly what it may do with each.
// The Connections screen renders these lists; the assistant only offers tools
// a source declares. See docs/assistant/CONNECTED-APPS.md.
//
// Two families:
//   google  — the assistant reads Google with the owner's OAuth grant.
//   app     — an app we build (Dream Board now; Sales Tracker, Pricing App,
//             EOS/Traction, GemMasters later) publishes its records to the
//             assistant and picks up operations the assistant queues for it.
//
// Capability values: 'yes' | 'confirm' (only after the owner approves) |
// 'future' (planned) | 'no' (deliberately not allowed).

import { SERVICES } from './google/services.mjs';

export const CAPABILITY_LABELS = {
  search: 'Search', read: 'Read', draft: 'Draft', send: 'Send',
  create: 'Add dreams', attach: 'Attach captures', events: 'Receive progress',
  milestone: 'Add milestones', update: 'Change goals', delete: 'Delete or merge',
  create_event: 'Create events', edit: 'Edit',
};

const GOOGLE_CAPS = {
  gmail: { search: 'yes', read: 'yes', draft: 'future', send: 'no' },
  calendar: { search: 'yes', read: 'yes', create_event: 'future' },
  drive: { search: 'yes', read: 'yes' },
  sheets: { search: 'yes', read: 'yes', edit: 'no' },
  contacts: { search: 'yes', read: 'yes' },
};

// Connected apps. `project` is the assistant project that acts as the app's
// hub; `ops` lists the operations the assistant may queue for it.
export const APPS = {
  dreamboard: {
    label: 'Dream Board',
    project: 'Dream Board',
    recordTypes: ['goal'],
    capabilities: { search: 'yes', read: 'yes', create: 'yes', attach: 'yes', events: 'yes', milestone: 'confirm', update: 'confirm', delete: 'no' },
    ops: {
      create_goal: { confirm: false },
      attach: { confirm: false },
      add_item: { confirm: false },
      add_milestone: { confirm: true },
      update_goal: { confirm: true },
    },
    // Goal fields the owner can change from the assistant (with confirmation).
    updatableFields: ['title', 'status', 'target_amount', 'target_date'],
  },
};
export const APP_KEYS = Object.keys(APPS);

// Planned apps — shown on Connections so the shape of the hub is visible.
export const PLANNED_APPS = [
  { id: 'alp_sales_tracker', label: 'ALP Sales Tracker' },
  { id: 'pricing_app', label: 'Pricing App' },
  { id: 'eos_traction', label: 'EOS / Traction' },
  { id: 'gemmasters', label: 'GemMasters' },
  { id: 'service_autopilot', label: 'Service Autopilot' },
  { id: 'ringcentral', label: 'RingCentral' },
];

export function googleCapabilities(key) { return GOOGLE_CAPS[key] || { search: 'yes', read: 'yes' }; }

export function capabilityList(caps) {
  return Object.entries(caps).map(([k, v]) => ({ key: k, label: CAPABILITY_LABELS[k] || k, value: v }));
}

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
  dreamboard: 'Dream Board',
};

export { SERVICES };
