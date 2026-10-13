// Наглядный предпросмотр текстовых файлов: CSV/TSV — таблицей, JSON — с отступами и цветом,
// Markdown — оформленным текстом, код — с подсветкой синтаксиса.
// Безопасность: всё строится из DOM-узлов и textContent — HTML из файла не вставляется
// никогда; ссылки в Markdown — только http(s)/mailto, внешние картинки не загружаются.
import { extOf, h } from './ui.js';

const MAX_ROWS = 500;
const MAX_COLS = 50;

// ---------- CSV / TSV ----------
function parseDelimited(text, sep) {
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; } else if (c === '"') quoted = false; else cell += c;
    } else if (c === '"' && cell === '') quoted = true;
    else if (c === sep) { row.push(cell); cell = ''; } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(cell); rows.push(row); row = []; cell = '';
      if (rows.length > MAX_ROWS) break;
    } else cell += c;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

function guessSeparator(text, ext) {
  if (ext === 'tsv') return '\t';
  const first = text.slice(0, text.indexOf('\n') >>> 0 || 2000);
  const counts = [',', ';', '\t'].map((s) => [s, first.split(s).length]);
  return counts.sort((a, b) => b[1] - a[1])[0][0];
}

function tableView(text, ext) {
  const rows = parseDelimited(text, guessSeparator(text, ext)).filter((r) => r.some((c) => c !== ''));
  if (rows.length < 2) return null;
  const cols = Math.min(MAX_COLS, Math.max(...rows.map((r) => r.length)));
  const [head, ...body] = rows;
  const cell = (tag, v) => h(tag, { class: tag === 'th' ? 'tv-th' : 'tv-td', title: v.length > 40 ? v : undefined }, v);
  const numeric = (v) => /^-?[\d\s]+([.,]\d+)?%?$/.test(v.trim());
  const table = h('table', { class: 'tv-table' },
    h('thead', {}, h('tr', {}, Array.from({ length: cols }, (_, i) => cell('th', head[i] ?? '')))),
    h('tbody', {}, body.slice(0, MAX_ROWS).map((r) => h('tr', {}, Array.from({ length: cols }, (_, i) => {
      const td = cell('td', r[i] ?? '');
      if (numeric(r[i] ?? '')) td.classList.add('tv-num');
      return td;
    })))));
  return h('div', { class: 'tv-scroll' }, table,
    h('p', { class: 'tv-note' }, `${body.length >= MAX_ROWS ? `Первые ${MAX_ROWS} строк` : `${body.length} строк`} · ${cols} столбцов`));
}

// ---------- подсветка синтаксиса ----------
const KEYWORDS = new Set(('abstract as async await break case catch class const continue def default del do elif else enum export ' +
  'extends false final finally fn for from func function go if impl import in interface is lambda let match mod mut new nil ' +
  'none not null or package pass private protected pub public raise return self static struct super switch this throw throws ' +
  'true try type typeof undefined use var void while with yield select insert update delete where join on group order by ' +
  'having limit create table alter drop into values set and begin end then fi done esac echo local').split(' '));
const HASH_COMMENT = new Set(['py', 'rb', 'sh', 'bash', 'zsh', 'yml', 'yaml', 'toml', 'ini', 'conf', 'cfg', 'env', 'dockerfile', 'makefile', 'gitignore', 'editorconfig', 'ps1', 'r']);
const SQL_COMMENT = new Set(['sql']);

function highlight(text, ext) {
  const comment = HASH_COMMENT.has(ext) ? '#[^\\n]*' : SQL_COMMENT.has(ext) ? '--[^\\n]*|\\/\\*[\\s\\S]*?\\*\\/' : '\\/\\*[\\s\\S]*?\\*\\/|\\/\\/[^\\n]*';
  const re = new RegExp([
    `(${comment})`,
    '("(?:\\\\.|[^"\\\\\\n])*"|\'(?:\\\\.|[^\'\\\\\\n])*\'|`(?:\\\\.|[^`\\\\])*`)',
    '(\\b(?:0x[0-9a-fA-F]+|\\d[\\d_]*(?:\\.\\d+)?(?:[eE][+-]?\\d+)?)\\b)',
    '([A-Za-z_$][\\w$]*)',
  ].join('|'), 'g');
  const out = [];
  let last = 0;
  for (const m of text.matchAll(re)) {
    const [tok, cmt, str, num, word] = m;
    let cls = null;
    if (cmt) cls = 'tk-comment';
    else if (str) cls = 'tk-string';
    else if (num) cls = 'tk-number';
    else if (word && KEYWORDS.has(word.toLowerCase())) cls = 'tk-keyword';
    else if (word && text[m.index + tok.length] === '(') cls = 'tk-func';
    if (!cls) continue;
    if (m.index > last) out.push(text.slice(last, m.index));
    out.push(h('span', { class: cls }, tok));
    last = m.index + tok.length;
  }
  out.push(text.slice(last));
  return out;
}

function codeView(text, ext) {
  return h('pre', { class: 'tv-code' }, h('code', {}, highlight(text, ext)));
}

function jsonView(text, ext) {
  try {
    const pretty = ext === 'jsonl'
      ? text.split('\n').filter(Boolean).slice(0, MAX_ROWS).map((l) => JSON.stringify(JSON.parse(l), null, 2)).join('\n')
      : JSON.stringify(JSON.parse(text), null, 2);
    return codeView(pretty, 'json');
  } catch {
    return null; // повреждённый или обрезанный JSON — покажем как есть
  }
}

// ---------- Markdown ----------
const SAFE_URL = /^(https?:|mailto:)/i;

function inline(text) {
  const out = [];
  const re = /(`[^`]+`)|(!?\[[^\]]*\]\([^)\s]+(?:\s+"[^"]*")?\))|(\*\*[^*]+\*\*|__[^_]+__)|(\*[^*\s][^*]*\*|_[^_\s][^_]*_)|(~~[^~]+~~)|(https?:\/\/[^\s<>()]+)/g;
  let last = 0;
  for (const m of text.matchAll(re)) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const [tok, code, link, bold, ital, strike, bare] = m;
    if (code) out.push(h('code', { class: 'md-code' }, code.slice(1, -1)));
    else if (link) {
      const lm = link.match(/^(!?)\[([^\]]*)\]\(([^)\s]+)/);
      const url = lm[3];
      const label = lm[2] || url;
      // Картинки по внешним адресам не загружаем (приватность) — показываем ссылкой.
      out.push(SAFE_URL.test(url)
        ? h('a', { href: url, target: '_blank', rel: 'noopener noreferrer nofollow', class: 'md-link' }, lm[1] ? `🖼 ${label}` : inline(label))
        : h('span', {}, label));
    } else if (bold) out.push(h('strong', {}, inline(bold.slice(2, -2))));
    else if (ital) out.push(h('em', {}, inline(ital.slice(1, -1))));
    else if (strike) out.push(h('s', {}, inline(strike.slice(2, -2))));
    else if (bare) out.push(h('a', { href: bare, target: '_blank', rel: 'noopener noreferrer nofollow', class: 'md-link' }, bare));
    last = m.index + tok.length;
  }
  out.push(text.slice(last));
  return out;
}

function markdownView(text) {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const root = h('div', { class: 'md' });
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const fence = line.match(/^\s*(```|~~~)\s*(\S*)/);
    if (fence) {
      const body = [];
      for (i++; i < lines.length && !lines[i].trim().startsWith(fence[1]); i++) body.push(lines[i]);
      i++;
      root.append(h('pre', { class: 'tv-code' }, h('code', {}, highlight(body.join('\n'), fence[2].toLowerCase()))));
      continue;
    }
    const heading = line.match(/^(#{1,6})\s+(.*?)\s*#*\s*$/);
    if (heading) { root.append(h(`h${heading[1].length}`, {}, inline(heading[2]))); i++; continue; }
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) { root.append(h('hr')); i++; continue; }
    if (/^\s*>/.test(line)) {
      const quote = [];
      for (; i < lines.length && /^\s*>/.test(lines[i]); i++) quote.push(lines[i].replace(/^\s*>\s?/, ''));
      root.append(h('blockquote', {}, inline(quote.join(' '))));
      continue;
    }
    if (/^\s*\|.*\|\s*$/.test(line) && /^\s*\|?\s*:?-{2,}/.test(lines[i + 1] ?? '')) {
      const split = (l) => l.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
      const head = split(line);
      const rows = [];
      for (i += 2; i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i]); i++) rows.push(split(lines[i]));
      root.append(h('div', { class: 'tv-scroll' }, h('table', { class: 'tv-table' },
        h('thead', {}, h('tr', {}, head.map((c) => h('th', { class: 'tv-th' }, inline(c))))),
        h('tbody', {}, rows.map((r) => h('tr', {}, head.map((_, k) => h('td', { class: 'tv-td' }, inline(r[k] ?? '')))))))));
      continue;
    }
    const item = line.match(/^\s*([-*+]|\d+[.)])\s+(.*)/);
    if (item) {
      const ordered = /\d/.test(item[1]);
      const list = h(ordered ? 'ol' : 'ul');
      for (; i < lines.length; i++) {
        const m = lines[i].match(/^\s*([-*+]|\d+[.)])\s+(.*)/);
        if (!m || /\d/.test(m[1]) !== ordered) break;
        const task = m[2].match(/^\[( |x|X)\]\s+(.*)/);
        list.append(h('li', {}, task ? [h('input', { type: 'checkbox', disabled: true, checked: task[1] !== ' ', class: 'check mr-1.5 align-[-2px]' }), ...inline(task[2])] : inline(m[2])));
      }
      root.append(list);
      continue;
    }
    if (!line.trim()) { i++; continue; }
    const para = [];
    for (; i < lines.length && lines[i].trim() && !/^(#{1,6}\s|\s*```|\s*>|\s*([-*+]|\d+[.)])\s)/.test(lines[i]); i++) para.push(lines[i].trim());
    root.append(h('p', {}, inline(para.join(' '))));
  }
  return root;
}

// ---------- выбор вида ----------
const CODE_EXT = new Set(('js mjs cjs ts tsx jsx css scss less html htm vue svelte py rb php go rs java kt kts c h cpp hpp cs ' +
  'swift sh bash zsh ps1 bat sql graphql proto dockerfile makefile xml yml yaml toml ini conf cfg env').split(' '));

/**
 * Оформленный вид текста или null, если для этого типа подходит только «как есть».
 * @returns {{ label: string, node: HTMLElement } | null}
 */
export function richView(name, text) {
  const ext = extOf(name) || name.toLowerCase();
  if (ext === 'csv' || ext === 'tsv') { const node = tableView(text, ext); return node && { label: 'Таблица', node }; }
  if (ext === 'json' || ext === 'jsonl') { const node = jsonView(text, ext); return node && { label: 'Форматированный', node }; }
  if (ext === 'md' || ext === 'markdown') return { label: 'Оформленный', node: markdownView(text) };
  if (CODE_EXT.has(ext)) return { label: 'С подсветкой', node: codeView(text, ext) };
  return null;
}
