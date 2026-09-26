// Personal Assistant API — the single Vercel function behind /assistant/.
// All logic lives in lib/assistant/; see docs/assistant/ARCHITECTURE.md.
import { createRouter } from '../lib/assistant/router.mjs';
import { toRequest, sendResponse } from '../lib/assistant/http.mjs';

const handle = createRouter();

export default async function handler(req, res) {
  let request;
  try { request = await toRequest(req); }
  catch (e) { return sendResponse(res, { status: e.status || 400, json: { error: e.status === 413 ? 'That upload is too large.' : 'Bad request' } }); }
  return sendResponse(res, await handle(request));
}
