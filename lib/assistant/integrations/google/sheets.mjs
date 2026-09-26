// Google Sheets adapter (read-only). Sheets API v4: spreadsheets.get (with a
// field mask — never grid data for the whole workbook) and values.batchGet.
// Spreadsheets are treated as workbooks → tabs → tables/headers → cells, not
// as a blob of text.

const BASE = 'https://sheets.googleapis.com/v4/spreadsheets';
const MAX_TABS_PREVIEW = 15;

export function parseSpreadsheetId(input) {
  const s = String(input || '').trim();
  const m = s.match(/\/spreadsheets\/d\/([-\w]{20,})/);
  if (m) return m[1];
  return /^[-\w]{20,}$/.test(s) ? s : null;
}

export function colLetter(n) {       // 1 → A, 27 → AA
  let s = '';
  while (n > 0) { const r = (n - 1) % 26; s = String.fromCharCode(65 + r) + s; n = Math.floor((n - 1) / 26); }
  return s || 'A';
}

// Tab titles go in single quotes in A1 notation; a quote inside is doubled.
export function quoteSheet(title) {
  return "'" + String(title).replace(/'/g, "''") + "'";
}

function gridRangeA1(gr, titleById) {
  if (!gr) return null;
  const t = titleById[gr.sheetId || 0];
  if (!t) return null;
  const c1 = colLetter((gr.startColumnIndex || 0) + 1), r1 = (gr.startRowIndex || 0) + 1;
  const c2 = gr.endColumnIndex ? colLetter(gr.endColumnIndex) : '', r2 = gr.endRowIndex || '';
  return quoteSheet(t) + '!' + c1 + r1 + (c2 || r2 ? ':' + c2 + r2 : '');
}

// First row that looks like a header: at least two non-empty text cells.
export function detectHeader(rows) {
  for (let i = 0; i < Math.min(rows.length, 5); i++) {
    const r = rows[i] || [];
    const filled = r.filter(v => String(v ?? '').trim() !== '');
    if (filled.length >= 2 && filled.filter(v => isNaN(Number(v))).length >= Math.ceil(filled.length / 2)) return { index: i, cells: r.map(v => String(v ?? '')) };
  }
  return rows.length ? { index: 0, cells: (rows[0] || []).map(v => String(v ?? '')) } : null;
}

export async function inspectSpreadsheet(client, spreadsheetId) {
  const meta = await client.get(BASE + '/' + encodeURIComponent(spreadsheetId), {
    fields: 'spreadsheetId,spreadsheetUrl,properties(title,timeZone,locale),' +
      'sheets(properties(sheetId,title,index,hidden,sheetType,gridProperties(rowCount,columnCount)),tables(name,range,columnProperties(columnName,columnType))),' +
      'namedRanges(name,range)',
  });
  const titleById = {};
  (meta.sheets || []).forEach(s => { titleById[s.properties.sheetId] = s.properties.title; });
  const tabs = (meta.sheets || []).map(s => ({
    sheetId: s.properties.sheetId,
    title: s.properties.title,
    index: s.properties.index,
    hidden: !!s.properties.hidden,
    type: s.properties.sheetType || 'GRID',
    rows: s.properties.gridProperties ? s.properties.gridProperties.rowCount : null,
    cols: s.properties.gridProperties ? s.properties.gridProperties.columnCount : null,
    tables: (s.tables || []).map(t => ({ name: t.name, range: gridRangeA1(t.range, titleById), columns: (t.columnProperties || []).map(c => ({ name: c.columnName, type: c.columnType })) })),
    header: null, sample: [],
  }));
  // One batched read for the top of every visible grid tab: headers + a few rows.
  const previewTabs = tabs.filter(t => t.type === 'GRID' && !t.hidden).slice(0, MAX_TABS_PREVIEW);
  if (previewTabs.length) {
    try {
      const vr = await client.get(BASE + '/' + encodeURIComponent(spreadsheetId) + '/values:batchGet', {
        ranges: previewTabs.map(t => quoteSheet(t.title) + '!A1:' + colLetter(Math.min(t.cols || 26, 26)) + '6'),
        valueRenderOption: 'FORMATTED_VALUE', majorDimension: 'ROWS',
      });
      (vr.valueRanges || []).forEach((v, i) => {
        const tab = previewTabs[i];
        const rows = v.values || [];
        const h = detectHeader(rows);
        tab.header = h ? h.cells : null;
        tab.headerRow = h ? h.index + 1 : null;
        tab.sample = rows.slice(h ? h.index + 1 : 0, (h ? h.index + 1 : 0) + 3);
      });
    } catch { /* metadata alone is still useful */ }
  }
  return {
    provider: 'google_sheets',
    kind: 'spreadsheet',
    recordId: meta.spreadsheetId,
    title: meta.properties ? meta.properties.title : '(spreadsheet)',
    url: meta.spreadsheetUrl || ('https://docs.google.com/spreadsheets/d/' + meta.spreadsheetId),
    date: null,
    snippet: tabs.map(t => t.title).join(' · '),
    meta: { timeZone: meta.properties && meta.properties.timeZone, tabCount: tabs.length },
    tabs,
    namedRanges: (meta.namedRanges || []).map(n => ({ name: n.name, range: gridRangeA1(n.range, titleById) })).filter(n => n.range),
  };
}

// A1 range read. `formulas: true` also returns the formula behind each
// computed cell, so an answer can say how a number is derived.
export async function readRange(client, spreadsheetId, range, { formulas = false, maxCells = 5000 } = {}) {
  const ranges = [range];
  const base = BASE + '/' + encodeURIComponent(spreadsheetId) + '/values:batchGet';
  const [vals, forms] = await Promise.all([
    client.get(base, { ranges, valueRenderOption: 'FORMATTED_VALUE', majorDimension: 'ROWS' }),
    formulas ? client.get(base, { ranges, valueRenderOption: 'FORMULA', majorDimension: 'ROWS' }) : null,
  ]);
  const vr = (vals.valueRanges || [])[0] || {};
  const rows = vr.values || [];
  let cells = 0, cut = rows.length;
  for (let i = 0; i < rows.length; i++) { cells += (rows[i] || []).length; if (cells > maxCells) { cut = i; break; } }
  const out = {
    range: vr.range || range,
    rows: rows.slice(0, cut),
    totalRows: rows.length,
    truncated: cut < rows.length,
  };
  if (forms) {
    const fr = ((forms.valueRanges || [])[0] || {}).values || [];
    const list = [];
    const startRow = Number((String(out.range).match(/!\$?[A-Z]+\$?(\d+)/) || [])[1] || 1);
    const startCol = ((String(out.range).match(/!\$?([A-Z]+)/) || [])[1] || 'A');
    const startColN = startCol.split('').reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0);
    fr.slice(0, cut).forEach((r, i) => (r || []).forEach((v, j) => {
      if (typeof v === 'string' && v.startsWith('=') && list.length < 300) list.push({ cell: colLetter(startColN + j) + (startRow + i), formula: v });
    }));
    out.formulas = list;
  }
  return out;
}
