/*
 * Портфель — чтение файлов Excel (.xlsx) без сторонних библиотек.
 * XLSX — это ZIP-архив с XML-файлами: архив распаковывается встроенным в браузер
 * DecompressionStream, XML разбирается регулярными выражениями (работает и в Node для тестов).
 * Читаются значения ячеек; у ячеек с формулами — последнее сохранённое значение, если оно есть.
 */
(function (root) {
  'use strict';

  /* ---------- ZIP ---------- */

  function u16(b, o) { return b[o] | (b[o + 1] << 8); }
  function u32(b, o) { return (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0; }

  async function inflateRaw(bytes) {
    if (typeof DecompressionStream === 'undefined') throw new Error('Браузер не умеет распаковывать архивы — обновите его');
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }

  // оглавление архива: имя → функция, возвращающая содержимое файла
  function zipEntries(buf) {
    const b = new Uint8Array(buf);
    let eocd = -1;
    for (let i = b.length - 22; i >= Math.max(0, b.length - 65557); i--) {
      if (u32(b, i) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd < 0) throw new Error('Файл не похож на документ Excel (.xlsx)');
    const count = u16(b, eocd + 10);
    let p = u32(b, eocd + 16);
    const entries = {};
    const dec = new TextDecoder('utf-8');
    for (let n = 0; n < count; n++) {
      if (u32(b, p) !== 0x02014b50) throw new Error('Повреждённый архив .xlsx');
      const method = u16(b, p + 10), size = u32(b, p + 20);
      const nameLen = u16(b, p + 28), extraLen = u16(b, p + 30), commentLen = u16(b, p + 32);
      const local = u32(b, p + 42);
      const name = dec.decode(b.subarray(p + 46, p + 46 + nameLen));
      entries[name] = async () => {
        const start = local + 30 + u16(b, local + 26) + u16(b, local + 28);
        const data = b.subarray(start, start + size);
        if (method === 0) return data;
        if (method === 8) return inflateRaw(data);
        throw new Error('Неподдерживаемое сжатие в .xlsx');
      };
      p += 46 + nameLen + extraLen + commentLen;
    }
    return entries;
  }

  /* ---------- XML ---------- */

  function unescapeXml(s) {
    return s.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (m, e) => {
      if (e[0] === '#') return String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10));
      return { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }[e.toLowerCase()];
    });
  }
  function attrs(s) {
    const o = {};
    s.replace(/([\w:]+)\s*=\s*("([^"]*)"|'([^']*)')/g, (m, k, _q, a, b2) => { o[k] = unescapeXml(a != null ? a : b2); });
    return o;
  }
  // текст из <t>…</t> (в том числе форматированный по частям), без фонетических подсказок <rPh>
  function textOf(xml) {
    xml = xml.replace(/<rPh\b[\s\S]*?<\/rPh>/g, '');
    let out = '';
    xml.replace(/<t\b[^>]*>([\s\S]*?)<\/t>/g, (m, t) => { out += t; });
    return unescapeXml(out);
  }

  function colIndex(ref) {
    const letters = ref.replace(/\d+$/, '');
    let n = 0;
    for (let i = 0; i < letters.length; i++) n = n * 26 + (letters.charCodeAt(i) - 64);
    return n;
  }

  function parseSheet(xml, shared) {
    const cells = {};
    let maxRow = 0, maxCol = 0;
    const re = /<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g;
    let m;
    while ((m = re.exec(xml))) {
      const a = attrs(m[1]), body = m[2] || '';
      if (!a.r) continue;
      const vm = /<v>([\s\S]*?)<\/v>/.exec(body);
      const v = vm ? unescapeXml(vm[1]) : null;
      let val = null;
      switch (a.t) {
        case 's': val = v == null ? null : shared[+v]; break;
        case 'inlineStr': val = textOf(body); break;
        case 'str': case 'd': val = v; break;
        case 'b': val = v === '1'; break;
        case 'e': val = null; break;
        default: val = v == null || v === '' ? null : Number(v);
      }
      if (val === null || val === '') continue;
      cells[a.r] = val;
      const row = +a.r.replace(/^[A-Z]+/, ''), col = colIndex(a.r);
      if (row > maxRow) maxRow = row;
      if (col > maxCol) maxCol = col;
    }
    return { cells, maxRow, maxCol };
  }

  /*
   * Читает книгу Excel.
   * Возвращает { sheets: { имя: { cells: {A1: значение}, maxRow, maxCol } }, names: [...], date1904 }
   */
  async function readXlsx(buf) {
    const files = zipEntries(buf);
    const text = async name => {
      const f = files[name];
      return f ? new TextDecoder('utf-8').decode(await f()) : null;
    };
    const wb = await text('xl/workbook.xml');
    if (!wb) throw new Error('Файл не похож на документ Excel (.xlsx)');
    const relsXml = (await text('xl/_rels/workbook.xml.rels')) || '';
    const rels = {};
    relsXml.replace(/<Relationship\b([^>]*)\/?>/g, (m, s) => { const a = attrs(s); rels[a.Id] = a.Target; });
    const shared = [];
    const sst = await text('xl/sharedStrings.xml');
    if (sst) sst.replace(/<si\b[^>]*>([\s\S]*?)<\/si>/g, (m, si) => { shared.push(textOf(si)); });
    const pr = /<workbookPr\b([^>]*)/.exec(wb);
    const date1904 = !!(pr && /date1904\s*=\s*"(1|true)"/.test(pr[1]));
    const sheets = {}, names = [];
    const list = [];
    wb.replace(/<sheet\b([^>]*)\/?>/g, (m, s) => { list.push(attrs(s)); });
    for (const a of list) {
      let target = rels[a['r:id']] || '';
      target = target.startsWith('/') ? target.slice(1) : 'xl/' + target.replace(/^\.\//, '');
      const xml = await text(target);
      if (xml == null) continue;
      sheets[a.name] = parseSheet(xml, shared);
      names.push(a.name);
    }
    return { sheets, names, date1904 };
  }

  // серийный номер даты Excel → 'YYYY-MM-DD'
  function excelDate(serial, date1904) {
    const base = date1904 ? Date.UTC(1904, 0, 1) : Date.UTC(1899, 11, 30);
    return new Date(base + Math.round(serial) * 86400000).toISOString().slice(0, 10);
  }

  const api = { readXlsx, excelDate, colIndex, zipEntries };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.PortfolioXlsx = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
