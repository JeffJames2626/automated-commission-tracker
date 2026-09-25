import { newId } from '../ids.mjs';
import { sha256 } from '../crypto.mjs';

export const MAX_ATTACHMENT_BYTES = 3 * 1024 * 1024;
const ALLOWED = /^(image\/(jpeg|png|webp|gif|heic|heif)|audio\/(webm|mp4|mpeg|ogg|wav|x-m4a|aac)|application\/pdf|text\/plain|text\/csv)$/;

export function attachmentKind(mime) {
  if (/^image\//.test(mime)) return 'image';
  if (/^audio\//.test(mime)) return 'audio';
  return 'file';
}

export function validateAttachment(a) {
  if (!a || typeof a.data !== 'string') return 'missing data';
  const mime = String(a.mime || '').toLowerCase().split(';')[0];
  if (!ALLOWED.test(mime)) return 'file type not supported: ' + mime;
  const bytes = Math.floor(a.data.length * 3 / 4);
  if (bytes > MAX_ATTACHMENT_BYTES) return 'file is larger than 3 MB';
  return null;
}

export async function addAttachment(db, userId, captureId, a) {
  const mime = String(a.mime || '').toLowerCase().split(';')[0];
  const buf = Buffer.from(a.data, 'base64');
  const hash = sha256(buf);
  const r = await db.query(`INSERT INTO asst_attachments (id, user_id, capture_id, kind, mime, name, size, sha256, data_b64, transcript)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT (user_id, capture_id, sha256) DO NOTHING
      RETURNING id, kind, mime, name, size, transcript, created_at`,
    [newId('attachment'), userId, captureId, attachmentKind(mime), mime, String(a.name || '').slice(0, 200) || null, buf.length, hash, buf.toString('base64'), a.transcript || null]);
  if (r[0]) return r[0];
  const ex = await db.query('SELECT id, kind, mime, name, size, transcript, created_at FROM asst_attachments WHERE user_id = $1 AND capture_id = $2 AND sha256 = $3', [userId, captureId, hash]);
  return ex[0];
}

export async function getAttachmentData(db, userId, id) {
  const r = await db.query('SELECT id, mime, name, size, data_b64 FROM asst_attachments WHERE id = $1 AND user_id = $2', [id, userId]);
  return r[0] || null;
}

export async function attachmentsForAI(db, userId, captureId) {
  return db.query("SELECT id, kind, mime, name, data_b64 FROM asst_attachments WHERE user_id = $1 AND capture_id = $2 AND kind IN ('image','file') ORDER BY created_at LIMIT 4", [userId, captureId]);
}
