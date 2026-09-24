import { SOURCE_LABEL } from '../integrations/registry.mjs';
import { oneLine } from '../text.mjs';

// Every item a tool retrieves gets a short label (S1, S2, …). The model cites
// those labels; the server then keeps only labels that really exist, so an
// answer can never point at a source that was not retrieved.

export class SourceRegistry {
  constructor() { this.byKey = new Map(); this.list = []; }

  add(item, evidence) {
    const key = item.provider + ':' + item.recordId;
    let s = this.byKey.get(key);
    if (!s) {
      s = {
        id: 'S' + (this.list.length + 1),
        provider: item.provider,
        label: SOURCE_LABEL[item.provider] || item.provider,
        kind: item.kind,
        recordId: String(item.recordId),
        title: oneLine(item.title, 160),
        url: item.url || null,
        date: item.date || null,
        snippet: oneLine(item.snippet || '', 280),
        evidence: [],
      };
      this.byKey.set(key, s);
      this.list.push(s);
    }
    // What the model actually saw from this source, kept for "why did you say that?"
    if (evidence) {
      const ev = oneLine(evidence, 600);
      if (ev && !s.evidence.includes(ev) && s.evidence.length < 4) s.evidence.push(ev);
    }
    return s.id;
  }

  get(id) { return this.list.find(s => s.id === id) || null; }
  all() { return this.list; }
}

const MARKER = /\[\s*(S\d+(?:\s*[,;]\s*S\d+)*)\s*\]/g;

// Remove citations of unknown sources, normalise "[S1, S2]" to "[S1][S2]",
// and report which sources the answer actually relied on.
export function finalizeCitations(text, registry) {
  const cited = new Set();
  const out = String(text || '').replace(MARKER, (m, group) => {
    const ids = group.split(/[,;]/).map(s => s.trim()).filter(id => registry.get(id));
    ids.forEach(id => cited.add(id));
    return ids.map(id => '[' + id + ']').join('');
  }).replace(/[ \t]+\n/g, '\n');
  return { text: out, cited: [...cited] };
}
