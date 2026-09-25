import { esc, icon, toast, sheet } from './ui.js';
import * as outbox from './outbox.js';
import { state, go } from './state.js';

// Capture: the composer ("What's on your mind?"), voice, camera, files,
// links and clipboard. The owner never has to pick a type or a folder.

const MAX_BYTES = 3 * 1024 * 1024;

// The server's explicit routing rule (lib/assistant/apps/routing.mjs), so an
// offline capture can already say where it is going.
const TO_BOARD = /\b(dream\s?board|vision\s?board)\b|\b(add|put|attach|save|stick|file|pin)\b[^.?!\n]{0,40}?\b(to|on|in|under|with|for)\s+(my|the|our)\s+[a-z0-9'&][a-z0-9' &\-]{0,58}?\s+(dream|goal)s?\b/i;

function b64(buf) {
  let s = '';
  const bytes = new Uint8Array(buf);
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

// Photos are shrunk on the phone (max 1600px, JPEG) so they upload fast on
// a weak connection and fit the size limit.
async function prepareImage(file) {
  if (!/^image\/(jpeg|png|webp|heic|heif)$/.test(file.type) && file.type) return null;
  try {
    const bmp = await createImageBitmap(file);
    const scale = Math.min(1, 1600 / Math.max(bmp.width, bmp.height));
    const c = document.createElement('canvas');
    c.width = Math.round(bmp.width * scale); c.height = Math.round(bmp.height * scale);
    c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
    const blob = await new Promise(r => c.toBlob(r, 'image/jpeg', 0.82));
    return { mime: 'image/jpeg', name: (file.name || 'photo').replace(/\.\w+$/, '') + '.jpg', data: b64(await blob.arrayBuffer()), preview: URL.createObjectURL(blob) };
  } catch {
    if (file.size > MAX_BYTES) return null;
    return { mime: file.type || 'image/jpeg', name: file.name || 'photo', data: b64(await file.arrayBuffer()), preview: URL.createObjectURL(file) };
  }
}

export async function fileToAttachment(file) {
  if (/^image\//.test(file.type)) return prepareImage(file);
  if (file.size > MAX_BYTES) { toast('That file is larger than 3 MB.'); return null; }
  if (!/^(application\/pdf|text\/plain|text\/csv)$/.test(file.type)) { toast('That file type is not supported yet.'); return null; }
  return { mime: file.type, name: file.name, data: b64(await file.arrayBuffer()) };
}

// ---------------- submitting ----------------
export async function submitCapture({ text = '', sourceType = 'text', attachments = [], forceCapture = false }) {
  const body = {
    text: text.trim(),
    source_type: sourceType,
    attachments: attachments.map(a => ({ mime: a.mime, name: a.name, data: a.data, transcript: a.transcript })),
    force_capture: forceCapture,
  };
  const r = await outbox.capture(body);
  if (r.queued) {
    const board = TO_BOARD.test(body.text) ? ' — waiting to add to Dream Board' : '';
    toast(navigator.onLine ? 'Saved on this phone' + board + '. Syncing when the server answers.' : 'Saved on this phone' + board + '. It will sync when you’re back online.', { tone: 'ok' });
    document.dispatchEvent(new CustomEvent('asst:captured', { detail: null }));
    return r;
  }
  if (r.intent === 'question' && !forceCapture) {
    // It was a question, not a thought to file: hand it to the assistant.
    document.dispatchEvent(new CustomEvent('asst:captured', { detail: null }));
    go('#/assistant', { ask: body.text });
    return r;
  }
  const c = r.capture || {};
  if (r.routing && r.routing.current) {
    const d = await import('./views/dreams.js');
    document.dispatchEvent(new CustomEvent('asst:captured', { detail: c }));
    if (r.routing.current.status === 'needs_choice') d.chooseDream(c.id, r.routing, { photo: attachments.some(a => /^image\//.test(a.mime)) });
    else toast(d.routeText(r.routing) || 'Saved', { tone: 'ok', action: 'View', onAction: () => go('#/item/' + c.id) });
    return r;
  }
  const kinds = state.boot ? state.boot.kinds : {};
  const label = (kinds[c.kind] ? kinds[c.kind].label : 'Note') + (c.project_name ? ' · ' + c.project_name : '');
  toast('Saved · ' + label, { tone: 'ok', action: 'Edit', onAction: () => go('#/item/' + c.id) });
  document.dispatchEvent(new CustomEvent('asst:captured', { detail: c }));
  return r;
}

// ---------------- voice ----------------
const SR = window.SpeechRecognition || window.webkitSpeechRecognition;

export function voiceSupported() { return !!(SR || (navigator.mediaDevices && window.MediaRecorder)); }

// Ramble freely: live transcript on screen, the recording kept alongside it.
export function openVoice({ onDone, title = 'Listening…' } = {}) {
  let finalText = '', interim = '', rec = null, media = null, chunks = [], stream = null, stopped = false;
  const s = sheet(`
    <div class="voice">
      <div class="voice-orb" aria-hidden="true"><span></span></div>
      <h3 class="sheet-title center" data-title>${esc(title)}</h3>
      <p class="voice-text" data-text aria-live="polite"><span class="muted">Start talking. Say it however it comes out.</span></p>
      <div class="row gap center mt">
        <button class="btn ghost" data-cancel>Cancel</button>
        <button class="btn primary" data-stop>${icon('check')} Done</button>
      </div>
    </div>`, { onClose: () => cleanup(), label: 'Voice capture' });
  const textEl = s.el.querySelector('[data-text]');
  const render = () => { textEl.innerHTML = (finalText || interim) ? esc(finalText) + '<span class="muted">' + esc(interim) + '</span>' : '<span class="muted">Start talking. Say it however it comes out.</span>'; };

  function cleanup() {
    stopped = true;
    try { rec && rec.stop(); } catch { /* already stopped */ }
    try { media && media.state !== 'inactive' && media.stop(); } catch { /* ignore */ }
    if (stream) stream.getTracks().forEach(t => t.stop());
  }

  if (SR) {
    rec = new SR();
    rec.continuous = true; rec.interimResults = true;
    rec.lang = navigator.language || 'en-US';
    rec.onresult = e => {
      interim = '';
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const r = e.results[i];
        if (r.isFinal) finalText += (finalText && !/\s$/.test(finalText) ? ' ' : '') + r[0].transcript.trim();
        else interim += r[0].transcript;
      }
      render();
    };
    rec.onerror = e => { if (e.error === 'not-allowed') s.el.querySelector('[data-title]').textContent = 'Microphone permission is off'; };
    // iOS ends recognition after a pause; keep listening until Done.
    rec.onend = () => { if (!stopped) { try { rec.start(); } catch { /* ignore */ } } };
    try { rec.start(); } catch { /* ignore */ }
  }
  // Keep the actual recording too, when the browser allows it alongside
  // recognition — the raw thought is never thrown away.
  if (navigator.mediaDevices && window.MediaRecorder) {
    navigator.mediaDevices.getUserMedia({ audio: true }).then(st => {
      if (stopped) { st.getTracks().forEach(t => t.stop()); return; }
      stream = st;
      const mime = ['audio/webm;codecs=opus', 'audio/mp4', 'audio/webm'].find(m => MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported(m)) || '';
      media = new MediaRecorder(st, mime ? { mimeType: mime, audioBitsPerSecond: 32000 } : undefined);
      media.ondataavailable = e => { if (e.data && e.data.size) chunks.push(e.data); };
      media.start(1000);
    }).catch(() => { if (!SR) s.el.querySelector('[data-title]').textContent = 'Microphone permission is off'; });
  }

  s.el.querySelector('[data-cancel]').onclick = () => s.close();
  s.el.querySelector('[data-stop]').onclick = async () => {
    stopped = true;
    try { rec && rec.stop(); } catch { /* ignore */ }
    let audio = null;
    if (media && media.state !== 'inactive') {
      await new Promise(res => { media.onstop = res; media.stop(); });
      const blob = new Blob(chunks, { type: (media.mimeType || 'audio/webm').split(';')[0] });
      if (blob.size && blob.size <= MAX_BYTES) audio = { mime: blob.type, name: 'voice.' + (blob.type.includes('mp4') ? 'm4a' : 'webm'), data: b64(await blob.arrayBuffer()) };
    }
    const transcript = (finalText + ' ' + interim).trim();
    s.close();
    if (!transcript && !audio) { toast('Didn’t catch anything.'); return; }
    if (audio) audio.transcript = transcript;
    onDone && onDone({ transcript, audio });
  };
  return s;
}

// ---------------- composer ----------------
// mode 'capture': dump anything. mode 'chat': ask the assistant.
export function composer({ placeholder = 'What’s on your mind?', mode = 'capture', onAsk } = {}) {
  const el = document.createElement('div');
  el.className = 'composer';
  el.innerHTML = `
    <div class="composer-atts" data-atts></div>
    <div class="composer-box">
      <textarea rows="1" placeholder="${esc(placeholder)}" aria-label="${esc(placeholder)}" enterkeyhint="send"></textarea>
      <button class="send" data-send aria-label="${mode === 'chat' ? 'Ask' : 'Save'}" disabled>${icon('send')}</button>
    </div>
    <div class="composer-tools">
      <button class="tool" data-voice aria-label="Voice">${icon('mic')}<span>Voice</span></button>
      ${mode === 'capture' ? `<button class="tool" data-camera aria-label="Camera">${icon('camera')}<span>Photo</span></button>
      <button class="tool" data-file aria-label="Attach a file">${icon('clip')}<span>File</span></button>
      <button class="tool" data-paste aria-label="Paste">${icon('paste')}<span>Paste</span></button>` : ''}
      <input type="file" accept="image/*" capture="environment" hidden data-camera-input>
      <input type="file" accept="image/*,application/pdf,text/plain,text/csv" hidden data-file-input multiple>
    </div>`;
  const ta = el.querySelector('textarea');
  const send = el.querySelector('[data-send]');
  const attsEl = el.querySelector('[data-atts]');
  let atts = [], sourceType = 'text', busy = false;

  const refresh = () => {
    send.disabled = busy || (!ta.value.trim() && !atts.length);
    if (ta.isConnected) { ta.style.height = 'auto'; ta.style.height = Math.max(26, Math.min(ta.scrollHeight, 180)) + 'px'; }
    attsEl.innerHTML = atts.map((a, i) => `<span class="att-chip">${a.preview ? `<img src="${a.preview}" alt="">` : icon(a.mime.startsWith('audio') ? 'mic' : 'note')}<span>${esc(a.name || 'attachment')}</span><button data-rm="${i}" aria-label="Remove">${icon('x')}</button></span>`).join('');
    attsEl.querySelectorAll('[data-rm]').forEach(b => b.onclick = () => { atts.splice(+b.dataset.rm, 1); refresh(); });
  };
  ta.addEventListener('input', () => { if (!ta.value) sourceType = 'text'; refresh(); });
  ta.addEventListener('keydown', e => {
    // Enter sends on a keyboard-and-mouse computer; on a phone Enter is a new line.
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && !window.matchMedia('(pointer: coarse)').matches) { e.preventDefault(); submit(); }
  });

  async function submit() {
    if (send.disabled) return;
    const text = ta.value;
    if (mode === 'chat') { ta.value = ''; refresh(); onAsk && onAsk(text); return; }
    busy = true; refresh();
    try {
      await submitCapture({ text, sourceType: atts.some(a => a.mime.startsWith('image')) && sourceType === 'text' ? 'photo' : (atts.some(a => !a.mime.startsWith('audio')) && sourceType === 'text' ? 'file' : sourceType), attachments: atts });
      ta.value = ''; atts = []; sourceType = 'text';
    } finally { busy = false; refresh(); }
  }
  send.onclick = submit;

  el.querySelector('[data-voice]').onclick = () => openVoice({
    onDone: ({ transcript, audio }) => {
      if (mode === 'chat') { ta.value = (ta.value ? ta.value + ' ' : '') + transcript; refresh(); ta.focus(); return; }
      // A voice ramble is saved straight away — that is the point of it.
      submitCapture({ text: transcript, sourceType: 'voice', attachments: audio ? [audio] : [] });
    },
  });
  const camIn = el.querySelector('[data-camera-input]'), fileIn = el.querySelector('[data-file-input]');
  const addFiles = async files => {
    for (const f of files) { const a = await fileToAttachment(f); if (a) atts.push(a); }
    atts = atts.slice(0, 4);
    refresh(); ta.focus();
  };
  if (mode === 'capture') {
    el.querySelector('[data-camera]').onclick = () => camIn.click();
    el.querySelector('[data-file]').onclick = () => fileIn.click();
    camIn.onchange = () => { addFiles([...camIn.files]); sourceType = 'photo'; camIn.value = ''; };
    fileIn.onchange = () => { addFiles([...fileIn.files]); fileIn.value = ''; };
    el.querySelector('[data-paste]').onclick = async () => {
      try {
        if (navigator.clipboard && navigator.clipboard.read) {
          const items = await navigator.clipboard.read();
          for (const it of items) {
            const img = it.types.find(t => t.startsWith('image/'));
            if (img) { await addFiles([new File([await it.getType(img)], 'screenshot.png', { type: img })]); sourceType = 'clipboard'; return; }
          }
        }
        const t = await navigator.clipboard.readText();
        if (t) { ta.value = (ta.value ? ta.value + '\n' : '') + t; sourceType = /^https?:\/\/\S+$/.test(t.trim()) ? 'link' : 'clipboard'; refresh(); ta.focus(); }
      } catch { toast('Paste with a long-press in the box instead — the browser blocked clipboard access.'); ta.focus(); }
    };
    // Pasting a screenshot straight into the box works too.
    ta.addEventListener('paste', e => {
      const files = [...(e.clipboardData ? e.clipboardData.files : [])].filter(f => f.type.startsWith('image/'));
      if (files.length) { e.preventDefault(); addFiles(files); sourceType = 'clipboard'; }
    });
  }
  el.setText = (t, st) => { ta.value = t; if (st) sourceType = st; refresh(); };
  el.focusInput = () => ta.focus();
  refresh();
  requestAnimationFrame(refresh);      // size the box once it is on the page
  return el;
}

// The oversized + button opens this.
export function openCaptureSheet({ text = '', sourceType } = {}) {
  const s = sheet('<h3 class="sheet-title">Capture</h3><p class="muted small">Type it, say it, snap it. I’ll file it.</p><div data-c></div>', { label: 'Capture' });
  const c = composer();
  s.el.querySelector('[data-c]').appendChild(c);
  if (text) c.setText(text, sourceType);
  document.addEventListener('asst:captured', () => s.close(), { once: true });
  setTimeout(() => c.focusInput(), 80);
  return s;
}
