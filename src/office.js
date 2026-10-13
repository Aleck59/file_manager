// Просмотр документов Office в браузере без сторонних программ и библиотек.
// docx/xlsx/pptx — это ZIP с XML внутри: нужные XML читаются из S3 диапазонами (zip.js)
// и превращаются в простую структуру (абзацы, таблицы, листы, слайды). Браузер строит
// из неё DOM сам — никакого HTML из документа на страницу не попадает.
//
// Память: XML документа — не больше 4 МБ, одновременно разбирается один документ.
import { entryBuffer, listZip } from './zip.js';

const MAX_XML = 4 * 1024 * 1024;
const MAX_BLOCKS = 3000;
const MAX_ROWS = 500;
const MAX_COLS = 50;
const MAX_SHEETS = 10;
const MAX_SLIDES = 200;
const MAX_TEXT = 1_000_000;

const fail = (status, message) => Object.assign(new Error(message), { status });

// Один разбор за раз: XML в несколько мегабайт — заметная доля кучи на маленьком VDS.
let chain = Promise.resolve();
const exclusive = (fn) => {
  const run = chain.then(fn, fn);
  chain = run.catch(() => {});
  return run;
};

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
const decode = (s) => s.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, e) => {
  if (e[0] === '#') {
    const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
    return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : '';
  }
  return ENTITIES[e] ?? m;
});
const attr = (attrs, name) => {
  const m = attrs.match(new RegExp(`\\b${name}="([^"]*)"`));
  return m ? decode(m[1]) : null;
};

/** Поток событий XML: [тип, имя, атрибуты] / ['text', текст]. Только то, что нужно здесь. */
function* tokens(xml) {
  const re = /<(\/?)([\w:.-]+)([^>]*?)(\/?)>|([^<]+)|<[!?][^>]*>/g;
  let m;
  while ((m = re.exec(xml))) {
    if (m[5] !== undefined) yield ['text', decode(m[5])];
    else if (m[2]) {
      if (m[1]) yield ['close', m[2]];
      else {
        yield ['open', m[2], m[3]];
        if (m[4]) yield ['close', m[2]];
      }
    }
  }
}

async function readXml(st, rel, entries, name, required = true) {
  const entry = entries.find((e) => e.name === name);
  if (!entry) {
    if (required) throw fail(422, 'Файл повреждён или это не документ Office');
    return null;
  }
  try {
    return (await entryBuffer(st, rel, entry, MAX_XML)).toString('utf8');
  } catch (err) {
    if (err instanceof RangeError || err.code === 'ERR_BUFFER_TOO_LARGE') throw fail(413, 'Документ слишком большой для просмотра');
    throw err;
  }
}

const off = (attrs) => /w:val="(0|false|none)"/.test(attrs);

// ---------- Word ----------
function headingLevel(style) {
  if (!style) return 0;
  if (/^title$/i.test(style)) return 1;
  const m = style.match(/^(?:heading|заголовок)?\s*([1-6])$/i);
  return m ? Number(m[1]) : 0;
}

function parseDocx(xml) {
  const blocks = [];
  let textSize = 0;
  let para = null; // {style, list, runs}
  let run = null; // {t, b, i, u, s}
  let inRunProps = false;
  let inText = false;
  const tables = []; // стек таблиц: {rows: [[cell]]}, cell — строка
  let cell = null;
  const pushPara = () => {
    if (!para) return;
    const text = para.runs.map((r) => r.t).join('');
    if (tables.length && cell !== null) {
      cell += (cell ? '\n' : '') + text;
    } else if (blocks.length < MAX_BLOCKS && textSize < MAX_TEXT) {
      textSize += text.length;
      const level = headingLevel(para.style);
      const list = para.list || /^(list|список)/i.test(para.style ?? '');
      blocks.push({ type: level ? 'h' : list ? 'li' : 'p', level: level || undefined, runs: para.runs.filter((r) => r.t) });
    }
    para = null;
  };
  for (const [type, name, attrs] of tokens(xml)) {
    if (type === 'text') {
      if (inText && run) run.t += name;
      continue;
    }
    if (type === 'open') {
      switch (name) {
        case 'w:tbl': tables.push({ rows: [] }); break;
        case 'w:tr': tables.at(-1)?.rows.push([]); break;
        case 'w:tc': cell = ''; break;
        case 'w:p': para = { style: null, list: false, runs: [] }; break;
        case 'w:pStyle': if (para) para.style = attr(attrs, 'w:val'); break;
        case 'w:numPr': if (para) para.list = true; break;
        case 'w:r': run = { t: '' }; break;
        case 'w:rPr': inRunProps = true; break;
        case 'w:b': if (run && inRunProps && !off(attrs)) run.b = true; break;
        case 'w:i': if (run && inRunProps && !off(attrs)) run.i = true; break;
        case 'w:u': if (run && inRunProps && !off(attrs)) run.u = true; break;
        case 'w:strike': if (run && inRunProps && !off(attrs)) run.s = true; break;
        case 'w:t': inText = true; break;
        case 'w:tab': if (run && !inRunProps) run.t += '\t'; break;
        case 'w:br': case 'w:cr': if (run) run.t += '\n'; break;
        default:
      }
    } else {
      switch (name) {
        case 'w:t': inText = false; break;
        case 'w:rPr': inRunProps = false; break;
        case 'w:r':
          if (run && para) {
            const prev = para.runs.at(-1);
            // Соседние куски с одинаковым оформлением склеиваем — Word режет текст очень мелко.
            if (prev && prev.b === run.b && prev.i === run.i && prev.u === run.u && prev.s === run.s) prev.t += run.t;
            else para.runs.push(run);
          }
          run = null;
          break;
        case 'w:p': pushPara(); break;
        case 'w:tc': {
          const t = tables.at(-1);
          if (t?.rows.length && t.rows.at(-1).length < MAX_COLS) t.rows.at(-1).push(cell ?? '');
          cell = null;
          break;
        }
        case 'w:tbl': {
          const t = tables.pop();
          if (!t) break;
          if (tables.length) {
            // Вложенная таблица — текстом в ячейку внешней.
            cell = (cell ?? '') + t.rows.map((r) => r.join(' | ')).join('\n');
          } else if (blocks.length < MAX_BLOCKS) {
            blocks.push({ type: 'table', rows: t.rows.slice(0, MAX_ROWS) });
          }
          break;
        }
        default:
      }
    }
  }
  return { kind: 'docx', blocks, truncated: blocks.length >= MAX_BLOCKS || textSize >= MAX_TEXT };
}

// ---------- Excel ----------
function parseSharedStrings(xml) {
  const out = [];
  if (!xml) return out;
  let cur = null;
  let inT = false;
  let inRph = false; // фонетические подсказки (японский) — не показываем
  for (const [type, name] of tokens(xml)) {
    if (type === 'open') {
      if (name === 'si') cur = '';
      else if (name === 't') inT = true;
      else if (name === 'rPh') inRph = true;
    } else if (type === 'close') {
      if (name === 'si') { out.push(cur ?? ''); cur = null; }
      else if (name === 't') inT = false;
      else if (name === 'rPh') inRph = false;
    } else if (inT && !inRph && cur !== null) cur += name;
  }
  return out;
}

const colIndex = (ref) => {
  let n = 0;
  for (const ch of ref.match(/^[A-Z]+/)?.[0] ?? '') n = n * 26 + ch.charCodeAt(0) - 64;
  return n - 1;
};

function parseSheet(xml, strings) {
  const rows = [];
  let row = null;
  let rowIndex = -1;
  let cell = null; // {col, type, v}
  let inV = false;
  let inT = false;
  let truncated = false;
  for (const [type, name, attrs] of tokens(xml)) {
    if (type === 'open') {
      if (name === 'row') {
        const r = Number(attr(attrs, 'r'));
        rowIndex = Number.isInteger(r) && r > 0 ? r - 1 : rowIndex + 1;
        if (rowIndex >= MAX_ROWS) { truncated = true; break; }
        row = [];
      } else if (name === 'c' && row) {
        const ref = attr(attrs, 'r');
        cell = { col: ref ? colIndex(ref) : row.length, type: attr(attrs, 't'), v: '' };
      } else if (name === 'v') inV = true;
      else if (name === 't') inT = true;
    } else if (type === 'close') {
      if (name === 'v') inV = false;
      else if (name === 't') inT = false;
      else if (name === 'c' && cell && row) {
        if (cell.col < MAX_COLS) {
          let value = cell.v;
          if (cell.type === 's') value = strings[Number(cell.v)] ?? '';
          else if (cell.type === 'b') value = cell.v === '1' ? 'ИСТИНА' : 'ЛОЖЬ';
          while (row.length < cell.col) row.push('');
          row[cell.col] = value;
        } else truncated = true;
        cell = null;
      } else if (name === 'row' && row) {
        while (rows.length < rowIndex) rows.push([]);
        rows[rowIndex] = row;
        row = null;
      }
    } else if (cell && (inV || (inT && cell.type === 'inlineStr'))) cell.v += name;
  }
  // Пустые строки в конце и пустые столбцы справа не нужны.
  while (rows.length && !rows.at(-1).some(Boolean)) rows.pop();
  return { rows, truncated };
}

async function parseXlsx(st, rel, entries) {
  const workbook = await readXml(st, rel, entries, 'xl/workbook.xml');
  const relsXml = await readXml(st, rel, entries, 'xl/_rels/workbook.xml.rels', false);
  const targets = new Map();
  for (const m of (relsXml ?? '').matchAll(/<Relationship\b([^>]*)>/g)) {
    const id = attr(m[1], 'Id');
    const target = attr(m[1], 'Target');
    if (id && target) targets.set(id, target.startsWith('/') ? target.slice(1) : `xl/${target}`);
  }
  const strings = parseSharedStrings(await readXml(st, rel, entries, 'xl/sharedStrings.xml', false));
  const sheets = [];
  let index = 0;
  const all = [...workbook.matchAll(/<sheet\b([^>]*)>/g)];
  for (const m of all.slice(0, MAX_SHEETS)) {
    index += 1;
    const name = attr(m[1], 'name') ?? `Лист ${index}`;
    if (attr(m[1], 'state') === 'hidden') continue;
    const path = targets.get(attr(m[1], 'r:id')) ?? `xl/worksheets/sheet${index}.xml`;
    const xml = await readXml(st, rel, entries, path.replace(/\/\.\//g, '/'), false);
    if (xml === null) continue;
    sheets.push({ name, ...parseSheet(xml, strings) });
  }
  return { kind: 'xlsx', sheets, moreSheets: Math.max(0, all.length - MAX_SHEETS) };
}

// ---------- PowerPoint ----------
function parseSlide(xml) {
  const paras = [];
  let cur = null;
  let inT = false;
  for (const [type, name] of tokens(xml)) {
    if (type === 'open') {
      if (name === 'a:p') cur = '';
      else if (name === 'a:t') inT = true;
      else if (name === 'a:br' && cur !== null) cur += '\n';
    } else if (type === 'close') {
      if (name === 'a:t') inT = false;
      else if (name === 'a:p') { if (cur?.trim()) paras.push(cur); cur = null; }
    } else if (inT && cur !== null) cur += name;
  }
  return paras;
}

async function parsePptx(st, rel, entries) {
  const slideNames = entries.map((e) => e.name).filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n))
    .sort((a, b) => Number(a.match(/\d+/)[0]) - Number(b.match(/\d+/)[0]));
  const slides = [];
  for (const name of slideNames.slice(0, MAX_SLIDES)) {
    const paras = parseSlide(await readXml(st, rel, entries, name));
    slides.push({ title: paras[0] ?? '', text: paras.slice(1) });
  }
  return { kind: 'pptx', slides, moreSlides: Math.max(0, slideNames.length - MAX_SLIDES) };
}

export const OFFICE_EXT = new Set(['docx', 'docm', 'xlsx', 'xlsm', 'pptx', 'pptm']);

/** @param {string} ext — расширение файла */
export function renderOffice(st, rel, size, ext) {
  return exclusive(async () => {
    const { entries } = await listZip(st, rel, size);
    if (ext.startsWith('doc')) return parseDocx(await readXml(st, rel, entries, 'word/document.xml'));
    if (ext.startsWith('xls')) return parseXlsx(st, rel, entries);
    return parsePptx(st, rel, entries);
  });
}

// Для тестов.
export const _internal = { parseDocx, parseSheet, parseSharedStrings, parseSlide };
