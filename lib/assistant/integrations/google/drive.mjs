import { clip, oneLine } from '../../text.mjs';

// Google Drive adapter (read-only). Drive API v3: files.list with Drive's
// query language (full-text search covers document contents, so a file can be
// found by what it says, not only its name), files.get, files.export.

const BASE = 'https://www.googleapis.com/drive/v3';
export const MIME = {
  doc: 'application/vnd.google-apps.document',
  sheet: 'application/vnd.google-apps.spreadsheet',
  slides: 'application/vnd.google-apps.presentation',
  folder: 'application/vnd.google-apps.folder',
  pdf: 'application/pdf',
};
const FIELDS = 'nextPageToken,files(id,name,mimeType,modifiedTime,createdTime,webViewLink,size,description,owners(displayName,emailAddress),lastModifyingUser(displayName,emailAddress))';

// Drive query strings are single-quoted; backslash and quote must be escaped.
export function escapeQ(s) {
  return String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

export function buildQuery({ query, type }) {
  const clauses = ['trashed = false'];
  const text = String(query || '').trim();
  if (text) {
    const phrase = escapeQ(text);
    const terms = text.split(/\s+/).filter(t => t.length > 1).slice(0, 5).map(escapeQ);
    const termClause = terms.length > 1
      ? '(' + terms.map(t => `(name contains '${t}' or fullText contains '${t}')`).join(' and ') + ')'
      : null;
    clauses.push('(' + [`name contains '${phrase}'`, `fullText contains '${phrase}'`, termClause].filter(Boolean).join(' or ') + ')');
  }
  if (type && type !== 'any') {
    if (type === 'file') clauses.push(`mimeType != '${MIME.folder}'`);
    else if (MIME[type]) clauses.push(`mimeType = '${MIME[type]}'`);
  }
  return clauses.join(' and ');
}

export function kindOf(mime) {
  if (mime === MIME.sheet) return 'spreadsheet';
  if (mime === MIME.doc) return 'document';
  if (mime === MIME.slides) return 'presentation';
  if (mime === MIME.folder) return 'folder';
  if (mime === MIME.pdf) return 'pdf';
  return 'file';
}

export function mapFile(f) {
  const kind = kindOf(f.mimeType);
  return {
    provider: kind === 'spreadsheet' ? 'google_sheets' : 'google_drive',
    kind,
    recordId: f.id,
    title: f.name || '(untitled)',
    snippet: oneLine(f.description || '', 200),
    url: f.webViewLink || ('https://drive.google.com/open?id=' + encodeURIComponent(f.id)),
    date: f.modifiedTime || f.createdTime || null,
    meta: {
      mimeType: f.mimeType,
      modifiedTime: f.modifiedTime || null,
      owner: f.owners && f.owners[0] ? (f.owners[0].displayName || f.owners[0].emailAddress) : '',
      lastModifiedBy: f.lastModifyingUser ? (f.lastModifyingUser.displayName || f.lastModifyingUser.emailAddress || '') : '',
      size: f.size ? Number(f.size) : null,
    },
  };
}

export async function searchFiles(client, { query, type = 'any', max = 10, modifiedAfter }) {
  let q = buildQuery({ query, type });
  if (modifiedAfter) q += ` and modifiedTime > '${escapeQ(modifiedAfter)}'`;
  const params = { q, fields: FIELDS, includeItemsFromAllDrives: true, supportsAllDrives: true, corpora: 'allDrives' };
  // Relevance order is only available with fullText; without text, newest first.
  if (!String(query || '').trim()) params.orderBy = 'modifiedTime desc';
  const r = await client.paginate(BASE + '/files', { params, itemsKey: 'files', maxItems: Math.min(max, 50), pageSizeParam: 'pageSize', pageSize: Math.min(max, 50) });
  return { items: r.items.map(mapFile), truncated: r.truncated };
}

export async function recentFiles(client, { days = 3, max = 8 }) {
  const after = new Date(Date.now() - days * 86400000).toISOString();
  return searchFiles(client, { query: '', type: 'file', max, modifiedAfter: after });
}

const TEXTISH = /^(text\/|application\/(json|xml|csv|x-yaml|javascript))/;
const MAX_PDF_BYTES = 8 * 1024 * 1024;

// Content for reading. Google Docs/Slides are exported to plain text; PDFs
// come back as bytes for the model to read directly; Sheets are pointed at the
// Sheets adapter, which understands tabs and cells.
export async function readFile(client, fileId, { maxChars = 30000 } = {}) {
  const f = await client.get(BASE + '/files/' + encodeURIComponent(fileId), {
    fields: 'id,name,mimeType,modifiedTime,createdTime,webViewLink,size,description,owners(displayName,emailAddress),lastModifyingUser(displayName,emailAddress)',
    supportsAllDrives: true,
  });
  const item = mapFile(f);
  const mime = f.mimeType || '';
  if (mime === MIME.sheet) return Object.assign(item, { content: null, contentNote: 'This is a spreadsheet — inspect it with the spreadsheet tools.' });
  if (mime === MIME.doc || mime === MIME.slides) {
    const text = await client.get(BASE + '/files/' + encodeURIComponent(fileId) + '/export', { mimeType: 'text/plain' }, { responseType: 'text' });
    return Object.assign(item, { content: clip(text, maxChars), truncated: text.length > maxChars });
  }
  if (mime === MIME.pdf) {
    if (f.size && Number(f.size) > MAX_PDF_BYTES) return Object.assign(item, { content: null, contentNote: 'PDF is too large to read here; open it in Drive.' });
    const buf = await client.get(BASE + '/files/' + encodeURIComponent(fileId), { alt: 'media', supportsAllDrives: true }, { responseType: 'buffer' });
    return Object.assign(item, { content: null, pdfBase64: buf.toString('base64') });
  }
  if (TEXTISH.test(mime)) {
    const text = await client.get(BASE + '/files/' + encodeURIComponent(fileId), { alt: 'media', supportsAllDrives: true }, { responseType: 'text' });
    return Object.assign(item, { content: clip(text, maxChars), truncated: text.length > maxChars });
  }
  return Object.assign(item, { content: null, contentNote: 'This file type (' + mime + ') cannot be read as text; open it in Drive.' });
}
