// Галерея: изображения папки на весь экран. Стрелки ←/→ (и свайп), масштаб колесом,
// двойным щелчком и кнопками, перетаскивание увеличенного снимка, Esc — закрыть.
// Ссылки на изображения берутся пачкой через /api/files/thumbs (только подпись, 15 мин).
import { api } from './api.js';
import { formatSize, h, icon, toast } from './ui.js';

const MIN = 1;
const MAX = 8;
const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

/**
 * @param {{key: string, name: string, size: number}[]} images
 * @param {number} start индекс открываемого
 */
export async function openGallery(images, start = 0) {
  if (!images.length) return;
  let index = Math.max(0, Math.min(images.length - 1, start));
  const urls = new Map();
  try {
    const { urls: got } = await api.thumbs(images.map((f) => f.key).slice(0, 200));
    for (const [k, v] of Object.entries(got)) urls.set(k, v);
  } catch (err) {
    return toast(err.message, 'error');
  }

  const img = h('img', { class: 'gallery-img', alt: '', draggable: 'false', decoding: 'async' });
  const stage = h('div', { class: 'gallery-stage' }, img);
  const caption = h('p', { class: 'min-w-0 truncate text-sm font-medium' });
  const counter = h('p', { class: 'shrink-0 text-xs tabular-nums text-white/60' });
  const zoomLabel = h('span', { class: 'w-12 text-center text-xs tabular-nums text-white/70' }, '100%');
  const btn = (name, label, onclick, extra = '') => h('button', { type: 'button', class: `gallery-btn ${extra}`, title: label, 'aria-label': label, onclick }, icon(name, 'h-5 w-5'));
  const prev = btn('chevronLeft', 'Предыдущее (←)', () => go(-1), 'gallery-nav left-3');
  const next = btn('chevronRight', 'Следующее (→)', () => go(1), 'gallery-nav right-3');
  const dialog = h('dialog', { class: 'gallery', 'aria-label': 'Просмотр изображений' },
    h('div', { class: 'flex items-center gap-3 px-4 py-3 text-white' },
      h('div', { class: 'min-w-0 flex-1' }, caption, counter),
      btn('zoomOut', 'Уменьшить (−)', () => zoomBy(1 / 1.5)), zoomLabel, btn('zoomIn', 'Увеличить (+)', () => zoomBy(1.5)),
      btn('download', 'Скачать', download),
      btn('close', 'Закрыть (Esc)', () => dialog.close())),
    stage, prev, next);

  // ---------- масштаб и сдвиг ----------
  let scale = 1;
  let tx = 0;
  let ty = 0;
  const apply = () => {
    img.style.transform = `translate(${tx}px, ${ty}px) scale(${scale})`;
    zoomLabel.textContent = `${Math.round(scale * 100)}%`;
    stage.classList.toggle('is-zoomed', scale > 1);
  };
  function clampPan() {
    const r = stage.getBoundingClientRect();
    const w = img.offsetWidth * scale;
    const hgt = img.offsetHeight * scale;
    const mx = Math.max(0, (w - r.width) / 2);
    const my = Math.max(0, (hgt - r.height) / 2);
    tx = Math.max(-mx, Math.min(mx, tx));
    ty = Math.max(-my, Math.min(my, ty));
  }
  function zoomTo(value, cx, cy) {
    const next = Math.max(MIN, Math.min(MAX, value));
    // Точка под курсором остаётся на месте.
    if (cx !== undefined) {
      const r = stage.getBoundingClientRect();
      const ox = cx - (r.left + r.width / 2);
      const oy = cy - (r.top + r.height / 2);
      tx = ox - ((ox - tx) * next) / scale;
      ty = oy - ((oy - ty) * next) / scale;
    }
    scale = next;
    if (scale === 1) { tx = 0; ty = 0; }
    clampPan();
    apply();
  }
  const zoomBy = (k, cx, cy) => zoomTo(scale * k, cx, cy);

  stage.addEventListener('wheel', (e) => { e.preventDefault(); zoomBy(e.deltaY < 0 ? 1.2 : 1 / 1.2, e.clientX, e.clientY); }, { passive: false });
  stage.addEventListener('dblclick', (e) => zoomTo(scale > 1 ? 1 : 2.5, e.clientX, e.clientY));

  // Перетаскивание (увеличенный снимок) и свайп (обычный масштаб).
  let drag = null;
  stage.addEventListener('pointerdown', (e) => {
    drag = { x: e.clientX, y: e.clientY, tx, ty, moved: false };
    stage.setPointerCapture(e.pointerId);
  });
  stage.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const dx = e.clientX - drag.x;
    const dy = e.clientY - drag.y;
    if (Math.abs(dx) + Math.abs(dy) > 4) drag.moved = true;
    if (scale > 1) { tx = drag.tx + dx; ty = drag.ty + dy; clampPan(); apply(); }
  });
  stage.addEventListener('pointerup', (e) => {
    if (!drag) return;
    const dx = e.clientX - drag.x;
    if (scale === 1 && Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(e.clientY - drag.y)) go(dx < 0 ? 1 : -1);
    else if (scale === 1 && !drag.moved && e.target === stage) dialog.close(); // щелчок по фону
    drag = null;
  });

  // ---------- листание ----------
  function show() {
    const file = images[index];
    scale = 1; tx = 0; ty = 0; apply();
    img.classList.remove('is-loaded');
    const url = urls.get(file.key);
    img.alt = file.name;
    if (url) img.src = url;
    caption.textContent = file.name;
    counter.textContent = `${index + 1} из ${images.length} · ${formatSize(file.size)}`;
    prev.disabled = index === 0;
    next.disabled = index === images.length - 1;
    // Соседние — заранее, чтобы листание было мгновенным.
    for (const j of [index - 1, index + 1]) {
      const u = images[j] && urls.get(images[j].key);
      if (u) { const pre = new Image(); pre.decoding = 'async'; pre.src = u; }
    }
  }
  img.addEventListener('load', () => img.classList.add('is-loaded'));
  function go(step) {
    const n = index + step;
    if (n < 0 || n >= images.length) return;
    index = n;
    if (!reduceMotion.matches) {
      stage.classList.remove('slide-left', 'slide-right');
      void stage.offsetWidth; // перезапуск анимации
      stage.classList.add(step > 0 ? 'slide-left' : 'slide-right');
    }
    show();
  }

  async function download() {
    try {
      const { url } = await api.downloadLink(images[index].key, 3600);
      window.location.assign(url);
    } catch (err) {
      toast(err.message, 'error');
    }
  }

  const onKey = (e) => {
    if (e.key === 'ArrowRight') { e.preventDefault(); go(1); }
    else if (e.key === 'ArrowLeft') { e.preventDefault(); go(-1); }
    else if (e.key === '+' || e.key === '=') zoomBy(1.5);
    else if (e.key === '-') zoomBy(1 / 1.5);
    else if (e.key === '0') zoomTo(1);
    else if (e.key === 'Home') { index = 0; show(); } else if (e.key === 'End') { index = images.length - 1; show(); }
  };
  dialog.addEventListener('keydown', onKey);
  dialog.addEventListener('close', () => dialog.remove());
  document.body.append(dialog);
  dialog.showModal();
  show();
  dialog.querySelector('button[aria-label^="Закрыть"]').focus();
}
