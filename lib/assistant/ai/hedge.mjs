// Tentative words are not decisions. "Maybe we should pay 5%" is an idea to
// think about; only "we decided to pay 5%" is a decision. These rules sit
// after the AI, so whatever the model says, tentative wording can't become a
// decision or a remembered fact.

const HEDGE = /\b(maybe|perhaps|possibly|probably|might|could we|should we|what if|how about|thinking (about|of)|i'?m thinking|wondering|consider(ing)?|not sure|unsure|idea|potentially|tempted|toying with|would it|we could|we might|i might|or maybe|kind of|sort of)\b|\?/i;
const DECIDED = /\b(we decided|i decided|decided (to|on|that)|decision (is|was|made)|final(ly)? (decision|answer)|going (forward )?with|we'?re going to|we will|from now on|effective (today|immediately|now)|agreed (to|on|that)|it'?s settled|locked in|approved)\b/i;
const ASKED_TO_REMEMBER = /\b(remember|don'?t forget|keep in mind|note that|make a note|for the record|fyi|save (this|that)|store (this|that)|log (this|that))\b/i;

export function isHedged(text) { return HEDGE.test(String(text || '')); }
export function statesDecision(text) { return DECIDED.test(String(text || '')) && !isHedged(text); }
export function asksToRemember(text) { return ASKED_TO_REMEMBER.test(String(text || '')); }

// A classification after the safety rules, plus the reasons they fired
// (shown in the capture review screen).
export function guardClassification(c, rawText) {
  const out = Object.assign({}, c), guard = [];
  const hedged = isHedged(rawText);
  if (out.kind === 'decision' && !statesDecision(rawText)) { out.kind = 'idea'; guard.push('tentative wording: decision → idea'); }
  if ((out.memories || []).length) {
    // A memory needs the owner to have asked, or to have stated a decision.
    const keep = hedged ? [] : out.memories.filter(m => (m.kind === 'decision' ? statesDecision(rawText) : asksToRemember(rawText) || statesDecision(rawText)));
    if (keep.length !== out.memories.length) guard.push('memory not saved: ' + (hedged ? 'tentative wording' : 'not asked to remember'));
    out.memories = keep;
  }
  // Unsure → it stays in the Inbox for the owner, and no project is invented.
  if (typeof out.confidence === 'number' && out.confidence < 0.5) {
    if (out.status && out.status !== 'inbox') guard.push('low confidence: kept in Inbox');
    out.status = 'inbox';
    if (out.newProjectName) { guard.push('low confidence: new project "' + out.newProjectName + '" not created'); out.newProjectName = ''; }
  }
  return { c: out, guard };
}
