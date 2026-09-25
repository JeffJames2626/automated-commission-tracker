import crypto from 'node:crypto';

// Permanent record ids: a readable type prefix + 20 random base32 characters
// (100 bits). Ids are never reused and never derived from names, so renaming
// or reclassifying a record never changes its identity.
const ALPHABET = 'abcdefghijkmnpqrstuvwxyz23456789';   // no l/o/0/1

export const PREFIX = {
  user: 'usr', capture: 'cap', project: 'prj', person: 'per', organization: 'org',
  identity: 'idn', tag: 'tag', link: 'lnk', memory: 'mem', attachment: 'att',
  conversation: 'cnv', message: 'msg', external: 'ext', connection: 'con', action: 'act',
  app: 'app', op: 'op', event: 'evt',
};

export function newId(type) {
  const p = PREFIX[type];
  if (!p) throw new Error('unknown id type ' + type);
  const bytes = crypto.randomBytes(20);
  let s = '';
  for (const b of bytes) s += ALPHABET[b & 31];
  return p + '_' + s;
}

export function isId(type, v) {
  const p = PREFIX[type];
  return typeof v === 'string' && new RegExp('^' + p + '_[' + ALPHABET + ']{20}$').test(v);
}
