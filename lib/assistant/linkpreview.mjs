import dns from 'node:dns';
import net from 'node:net';
import { htmlToText, oneLine } from './text.mjs';

// Title + description for a pasted link, fetched server-side. Guarded against
// server-side request forgery: http(s) only, standard ports, every hop's DNS
// answers must be public addresses, few redirects, small bodies, short timeout.

export function isPrivateAddress(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
  }
  const v = ip.toLowerCase();
  if (v.startsWith('::ffff:')) return isPrivateAddress(v.slice(7));
  return v === '::' || v === '::1' || v.startsWith('fc') || v.startsWith('fd') || v.startsWith('fe8') || v.startsWith('fe9') || v.startsWith('fea') || v.startsWith('feb') || v.startsWith('ff');
}

export async function assertPublicUrl(raw, lookup = dns.promises.lookup) {
  let u;
  try { u = new URL(raw); } catch { throw new Error('not a url'); }
  if (!/^https?:$/.test(u.protocol)) throw new Error('only http(s) links');
  if (u.username || u.password) throw new Error('credentials in url');
  if (u.port && !['80', '443'].includes(u.port)) throw new Error('non-standard port');
  const host = u.hostname.replace(/^\[|\]$/g, '');
  const addrs = net.isIP(host) ? [{ address: host }] : await lookup(host, { all: true });
  if (!addrs.length || addrs.some(a => isPrivateAddress(a.address))) throw new Error('private address');
  return u;
}

export async function linkPreview(raw, { fetchImpl = fetch, lookup, timeoutMs = 5000, maxBytes = 300_000 } = {}) {
  let url = raw;
  for (let hop = 0; hop < 4; hop++) {
    const u = await assertPublicUrl(url, lookup);
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    let r;
    try { r = await fetchImpl(u.toString(), { redirect: 'manual', signal: ctrl.signal, headers: { 'user-agent': 'PersonalAssistantLinkPreview/1.0', accept: 'text/html' } }); }
    finally { clearTimeout(t); }
    if (r.status >= 300 && r.status < 400 && r.headers.get('location')) { url = new URL(r.headers.get('location'), u).toString(); continue; }
    if (!r.ok) return null;
    if (!/text\/html/i.test(r.headers.get('content-type') || '')) return { url: u.toString(), title: null, description: null };
    const reader = r.body && r.body.getReader ? r.body.getReader() : null;
    let html = '';
    if (reader) {
      const dec = new TextDecoder();
      let size = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.length;
        html += dec.decode(value, { stream: true });
        if (size > maxBytes) { try { await reader.cancel(); } catch { /* ignore */ } break; }
      }
    } else html = (await r.text()).slice(0, maxBytes);
    const meta = name => {
      const m = html.match(new RegExp('<meta[^>]+(?:property|name)=["\']' + name + '["\'][^>]*content=["\']([^"\']*)["\']', 'i')) ||
        html.match(new RegExp('<meta[^>]+content=["\']([^"\']*)["\'][^>]*(?:property|name)=["\']' + name + '["\']', 'i'));
      return m ? oneLine(htmlToText(m[1]), 300) : null;
    };
    const title = meta('og:title') || (html.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1];
    return { url: u.toString(), title: title ? oneLine(htmlToText(title), 200) : null, description: meta('og:description') || meta('description') };
  }
  return null;
}
