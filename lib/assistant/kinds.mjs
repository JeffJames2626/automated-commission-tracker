// The vocabulary of captures. One table holds them all; `kind` is a label the
// AI suggests and the owner can change at any time.

export const KINDS = {
  idea: { label: 'Idea', emoji: '💡' },
  business_idea: { label: 'Business idea', emoji: '🚀' },
  product_idea: { label: 'Product idea', emoji: '🧩' },
  task: { label: 'Task', emoji: '✅' },
  reminder: { label: 'Reminder', emoji: '⏰' },
  goal: { label: 'Goal', emoji: '🎯' },
  dream: { label: 'Dream', emoji: '✨' },
  note: { label: 'Note', emoji: '📝' },
  person: { label: 'Person', emoji: '👤' },
  decision: { label: 'Decision', emoji: '⚖️' },
  purchase: { label: 'Purchase', emoji: '🛒' },
  property: { label: 'Property', emoji: '🏡' },
  travel: { label: 'Travel idea', emoji: '✈️' },
  website: { label: 'Website', emoji: '🔗' },
  photo: { label: 'Photo', emoji: '📷' },
  document: { label: 'Document', emoji: '📄' },
  voice_note: { label: 'Voice note', emoji: '🎙️' },
  thought: { label: 'Random thought', emoji: '💭' },
  question: { label: 'Question asked', emoji: '❓' },
  // Whatever the owner typed or said, kept whole; the assistant pulls the
  // tasks, ideas and questions out of it into their own items.
  journal: { label: 'Journal entry', emoji: '📓' },
};
export const KIND_KEYS = Object.keys(KINDS);

// Idea lifecycle. Nothing is forced to become a task.
export const STATUSES = {
  inbox: 'Inbox', thinking: 'Thinking', maybe: 'Maybe', active: 'Active', built: 'Built', archived: 'Archived',
  // Sent to the app that owns it (e.g. Dream Board). The capture stays as the
  // record of what was said; the app's record is the current truth.
  filed: 'Filed',
};
export const STATUS_KEYS = Object.keys(STATUSES);

export const PROJECT_KINDS = ['business', 'project', 'topic', 'area'];

// Starting subjects for a new account (all editable, all deletable).
export const DEFAULT_PROJECTS = [
  { name: 'ALP', kind: 'business', emoji: '🌱', aliases: ['Automated Lawn & Pest', 'Automated Lawn and Pest', 'Automated Lawn'] },
  { name: 'GemMasters', kind: 'business', emoji: '💎', aliases: ['Gem Masters'] },
  { name: 'Personal', kind: 'area', emoji: '🙂', aliases: [] },
  { name: 'Dream Board', kind: 'topic', emoji: '✨', aliases: ['dreamboard', 'dream list'], source_app: 'dreamboard' },
  { name: 'Pricing App', kind: 'project', emoji: '🧮', aliases: ['pricing tool', 'pricing calculator'] },
  { name: 'Sales Tracker', kind: 'project', emoji: '📈', aliases: ['sales app', 'commission tracker', 'ALP Sales Tracker'] },
  { name: 'House', kind: 'area', emoji: '🏠', aliases: ['home'] },
  { name: 'Travel', kind: 'topic', emoji: '✈️', aliases: ['trips'] },
  { name: 'Investments', kind: 'topic', emoji: '📊', aliases: ['investing'] },
  { name: 'Future Businesses', kind: 'topic', emoji: '🚀', aliases: ['new business', 'business ideas'] },
];
