// График «Рост занятого места» на главной: одна серия, линия 2px + заливка ~10%,
// тонкая сетка, перекрестие с подсказкой (мышь, касание, стрелки с клавиатуры) и
// скрытая таблица для экранных дикторов. Цвет — токен --chart-line (проверен
// валидатором палитры для светлой и тёмной темы).
import { $, formatSize, h, pluralize, FILES } from './ui.js';

const SVG = 'http://www.w3.org/2000/svg';
const s = (tag, attrs = {}) => {
  const el = document.createElementNS(SVG, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  return el;
};
const dayFmt = new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'short' });
const fullFmt = new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' });
const parseDay = (d) => { const [y, m, dd] = d.split('-').map(Number); return new Date(y, m - 1, dd); };

function niceMax(v) {
  if (v <= 0) return 1;
  const p = 1024 ** Math.floor(Math.log(v) / Math.log(1024));
  const steps = [1, 2, 2.5, 4, 5, 8, 10, 16, 20, 25, 40, 50, 80, 100, 128, 200, 256, 400, 512, 800, 1024];
  return p * (steps.find((x) => x * p >= v * 1.08) ?? 1024);
}

/** @param {{d: string, size: number, files: number}[]} points */
export function usageChart(points) {
  const wrap = h('div', { class: 'relative' });
  if (points.length < 2) {
    wrap.append(h('div', { class: 'flex h-40 flex-col items-center justify-center rounded-xl bg-slate-50 px-6 text-center dark:bg-slate-800/40' },
      h('p', { class: 'text-sm font-medium' }, points.length ? `Сейчас занято ${formatSize(points[0].size)}` : 'Пока нет данных'),
      h('p', { class: 'mt-1 text-xs text-slate-500 dark:text-slate-400' }, 'График появится через пару дней — точка сохраняется раз в день при подсчёте места.')));
    return wrap;
  }

  const H = 176;
  const pad = { top: 12, right: 12, bottom: 24, left: 56 };
  const max = niceMax(Math.max(...points.map((p) => p.size)));
  const svg = s('svg', { class: 'usage-chart block w-full', height: H, role: 'img', tabindex: '0',
    'aria-label': `Рост занятого места: от ${formatSize(points[0].size)} до ${formatSize(points.at(-1).size)} за ${points.length} дн. Стрелками — значения по дням.` });
  const tip = $('#chart-tooltip');
  let active = points.length - 1;
  let W = 0;

  const x = (i) => pad.left + (i / (points.length - 1)) * (W - pad.left - pad.right);
  const y = (v) => pad.top + (1 - v / max) * (H - pad.top - pad.bottom);

  function draw() {
    W = wrap.clientWidth || 600;
    svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    svg.replaceChildren();
    // Сетка и подписи оси Y: 0, ½, максимум.
    for (const f of [0, 0.5, 1]) {
      const yy = y(max * f);
      svg.append(s('line', { x1: pad.left, x2: W - pad.right, y1: yy, y2: yy, class: 'chart-grid' }));
      const t = s('text', { x: pad.left - 8, y: yy + 4, 'text-anchor': 'end', class: 'chart-axis' });
      t.textContent = formatSize(max * f);
      svg.append(t);
    }
    // Подписи оси X: первый, средний и последний день.
    const idx = [...new Set([0, Math.floor((points.length - 1) / 2), points.length - 1])];
    idx.forEach((i, k) => {
      const t = s('text', { x: x(i), y: H - 6, 'text-anchor': k === 0 ? 'start' : k === idx.length - 1 ? 'end' : 'middle', class: 'chart-axis' });
      t.textContent = dayFmt.format(parseDay(points[i].d));
      svg.append(t);
    });
    const line = points.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(p.size).toFixed(1)}`).join('');
    svg.append(s('path', { d: `${line}L${x(points.length - 1)},${y(0)}L${x(0)},${y(0)}Z`, class: 'chart-area' }));
    svg.append(s('path', { d: line, class: 'chart-line' }));
    svg.append(s('line', { class: 'chart-cross hidden', y1: pad.top, y2: H - pad.bottom }));
    svg.append(s('circle', { class: 'chart-dot hidden', r: 4 }));
  }

  function show(i, clientX, clientY) {
    active = i;
    const p = points[i];
    const cross = svg.querySelector('.chart-cross');
    const dot = svg.querySelector('.chart-dot');
    cross.setAttribute('x1', x(i)); cross.setAttribute('x2', x(i)); cross.classList.remove('hidden');
    dot.setAttribute('cx', x(i)); dot.setAttribute('cy', y(p.size)); dot.classList.remove('hidden');
    tip.replaceChildren(
      h('div', { class: 'font-medium' }, fullFmt.format(parseDay(p.d))),
      h('div', { class: 'tabular-nums' }, `${formatSize(p.size)} · ${pluralize(p.files, FILES)}`));
    tip.classList.remove('hidden');
    const r = svg.getBoundingClientRect();
    const px = clientX ?? r.left + (x(i) / W) * r.width;
    const py = clientY ?? r.top + y(p.size);
    tip.style.left = `${Math.min(window.innerWidth - tip.offsetWidth - 8, px + 12)}px`;
    tip.style.top = `${Math.max(8, py - tip.offsetHeight - 12)}px`;
  }
  function hide() {
    svg.querySelector('.chart-cross')?.classList.add('hidden');
    svg.querySelector('.chart-dot')?.classList.add('hidden');
    tip.classList.add('hidden');
  }
  const nearest = (clientX) => {
    const r = svg.getBoundingClientRect();
    const px = ((clientX - r.left) / r.width) * W;
    return Math.max(0, Math.min(points.length - 1, Math.round(((px - pad.left) / (W - pad.left - pad.right)) * (points.length - 1))));
  };
  svg.addEventListener('pointermove', (e) => show(nearest(e.clientX), e.clientX, e.clientY));
  svg.addEventListener('pointerleave', hide);
  svg.addEventListener('focus', () => show(active));
  svg.addEventListener('blur', hide);
  svg.addEventListener('keydown', (e) => {
    const step = { ArrowLeft: -1, ArrowRight: 1, Home: -Infinity, End: Infinity }[e.key];
    if (step === undefined) return;
    e.preventDefault();
    show(Math.max(0, Math.min(points.length - 1, active + step)));
  });

  // Таблица для экранных дикторов (последние 31 день).
  const table = h('table', { class: 'sr-only' },
    h('caption', {}, 'Занятое место по дням'),
    h('thead', {}, h('tr', {}, h('th', {}, 'Дата'), h('th', {}, 'Занято'), h('th', {}, 'Файлов'))),
    h('tbody', {}, points.slice(-31).map((p) => h('tr', {}, h('td', {}, fullFmt.format(parseDay(p.d))), h('td', {}, formatSize(p.size)), h('td', {}, String(p.files))))));

  wrap.append(svg, table);
  requestAnimationFrame(draw);
  if ('ResizeObserver' in window) {
    let last = 0;
    new ResizeObserver(() => { if (wrap.clientWidth !== last) { last = wrap.clientWidth; hide(); draw(); } }).observe(wrap);
  }
  return wrap;
}
