// Tentative words are not decisions. "Maybe we should pay 5%" is an idea to
// think about; "we decided to pay 5%" or "Decision: pay 5%" is a decision.
// These rules sit after the AI, so whatever the model says, tentative wording
// can't become a decision or a remembered fact. They judge sentence by
// sentence, so one "maybe" elsewhere in a journal entry doesn't cancel a
// settled decision or an explicit "remember…".

const HEDGE = /\b(maybe|perhaps|possibly|probably|might|could we|should we|shall we|what if|how about|thinking (about|of)|i'?m thinking|wondering|considering|not sure|unsure|potentially|tempted|toying with|would it be|we could|we might|i might|or maybe)\b/i;
const DECIDED = /\b(we decided|i decided|decided (to|on|that)|decided:|decision:|decision (is|was|made)|final(ly)? (decision|answer)|going (forward )?with|we'?re going to|we'?ll|we will|from now on|effective (today|immediately|now)|agreed (to|on|that)|it'?s settled|locked in|approved)\b/i;
const ASKED_TO_REMEMBER = /\b(remember|don'?t forget|keep in mind|note that|make a note|for the record|fyi|save (this|that)|store (this|that)|log (this|that))\b/i;
const YES = /^\s*(yes|yep|yeah|yup|sure|please do|do it|go ahead|ok(ay)?|sounds good|correct|that'?s right)\b/i;

export const sentences = text => String(text || '').split(/(?<=[.!?])\s+|\n+/).map(s => s.trim()).filter(Boolean);
export function isHedged(text) { return HEDGE.test(String(text || '')); }
// Some sentence states a decision in settled words.
export function statesDecision(text) { return sentences(text).some(s => DECIDED.test(s) && !isHedged(s)); }
// Some sentence asks to remember, without hedging ("can you remember…?" counts).
export function asksToRemember(text) { return sentences(text).some(s => ASKED_TO_REMEMBER.test(s) && !isHedged(s)); }
// Every sentence is tentative (and none states a decision).
export function allTentative(text) { const ss = sentences(text); return ss.length > 0 && !statesDecision(text) && ss.every(s => isHedged(s) || !/\w/.test(s)); }
// "Yes" to the assistant's own offer to remember something.
export function acceptsOffer(text, lastAssistant) { return YES.test(String(text || '')) && /\bremember\b/i.test(String(lastAssistant || '')); }

// May the owner's words become a memory of this kind?
export function mayRemember(kind, ownerText, lastAssistant) {
  if (acceptsOffer(ownerText, lastAssistant)) return true;
  if (kind === 'decision') return statesDecision(ownerText) || asksToRemember(ownerText);
  return asksToRemember(ownerText) || statesDecision(ownerText);
}

// A classification after the safety rules, plus the reasons they fired
// (shown in the capture review screen).
export function guardClassification(c, rawText) {
  const out = Object.assign({}, c), guard = [];
  const tentative = isHedged(rawText) && !statesDecision(rawText);
  if (out.kind === 'decision' && tentative) { out.kind = 'idea'; guard.push('tentative wording: decision → idea'); }
  if ((out.memories || []).length) {
    // A memory needs the owner to have asked, or to have stated a decision;
    // a memory worded tentatively is never kept.
    const keep = out.memories.filter(m => !isHedged(m.statement) && mayRemember(m.kind, rawText));
    if (keep.length !== out.memories.length) guard.push('memory not saved: ' + (tentative ? 'tentative wording' : 'not asked to remember'));
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
