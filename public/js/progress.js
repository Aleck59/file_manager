// Плавный индикатор прогресса загрузки.
// Браузер сообщает об отправленных байтах рывками (буфер сокета, параллельные части
// multipart), поэтому полоса не прыгает к каждому событию, а догоняет его в общем цикле
// requestAnimationFrame. Двигается только transform (без пересчёта раскладки), полоса
// никогда не отъезжает назад (повтор упавшей части), текст обновляется 4 раза в секунду,
// скорость — по скользящему окну, а не средняя с начала загрузки.
import { formatSize } from './ui.js';

const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
const EASE_SEC = 0.35; // постоянная времени догоняния
const TEXT_EVERY_MS = 250;
const SPEED_WINDOW_MS = 4000;

const running = new Set();
let frame = 0;
let lastTime = 0;

function tick(now) {
  const dt = lastTime ? Math.min(0.1, (now - lastTime) / 1000) : 1 / 60;
  lastTime = now;
  for (const view of running) view.step(now, dt);
  if (running.size) {
    frame = requestAnimationFrame(tick);
  } else {
    frame = 0;
    lastTime = 0;
  }
}

function run(view) {
  running.add(view);
  if (!frame) frame = requestAnimationFrame(tick);
}

function formatEta(sec) {
  if (!Number.isFinite(sec) || sec <= 0) return '';
  if (sec < 60) return `≈ ${Math.max(1, Math.round(sec))} с`;
  if (sec < 3600) return `≈ ${Math.round(sec / 60)} мин`;
  return `≈ ${(sec / 3600).toFixed(1).replace('.', ',')} ч`;
}

export class ProgressView {
  /**
   * @param {HTMLElement} bar  полоса внутри .progress
   * @param {HTMLElement} label  текст статуса (проценты, скорость, оставшееся время)
   * @param {number} total  размер файла в байтах
   */
  constructor(bar, label, total) {
    this.bar = bar;
    this.label = label;
    this.total = Math.max(1, total);
    this.target = 0;
    this.shown = 0;
    this.samples = [];
    this.textAt = 0;
    this.done = false;
  }

  /** Новое значение отправленных байтов (из события XHR). */
  update(loaded) {
    if (this.done || loaded <= this.target) return;
    this.target = Math.min(loaded, this.total);
    const now = performance.now();
    this.samples.push([now, this.target]);
    while (this.samples.length > 2 && now - this.samples[0][0] > SPEED_WINDOW_MS) this.samples.shift();
    run(this);
  }

  speed() {
    const first = this.samples[0];
    const last = this.samples[this.samples.length - 1];
    if (!first || last[0] - first[0] < 800) return 0;
    return ((last[1] - first[1]) * 1000) / (last[0] - first[0]);
  }

  step(now, dt) {
    const k = reduceMotion.matches ? 1 : 1 - Math.exp(-dt / EASE_SEC);
    this.shown += (this.target - this.shown) * k;
    if (this.target - this.shown < this.total / 2000) this.shown = this.target;
    this.paint(this.shown / this.total);
    if (now - this.textAt >= TEXT_EVERY_MS || this.shown === this.target) {
      this.textAt = now;
      this.writeText();
    }
    if (this.shown === this.target) running.delete(this);
  }

  paint(fraction) {
    // Полоса шириной 100% сдвинута влево: так скруглённый край не искажается (в отличие от scaleX).
    this.bar.style.transform = `translateX(${(fraction - 1) * 100}%)`;
  }

  writeText() {
    if (this.done) return;
    if (this.target >= this.total) {
      // Байты отправлены, ждём ответа хранилища и завершения на сервере.
      this.label.textContent = 'Завершение…';
      this.bar.parentElement.classList.add('is-finishing');
      return;
    }
    const pct = Math.floor((this.shown / this.total) * 100);
    const speed = this.speed();
    const parts = [`${pct}%`];
    if (speed > 0) parts.push(`${formatSize(speed)}/с`, formatEta((this.total - this.target) / speed));
    this.label.textContent = parts.filter(Boolean).join(' · ');
  }

  /** Завершение: ok — успешно, иначе ошибка. */
  finish(ok) {
    this.done = true;
    running.delete(this);
    this.bar.parentElement.classList.remove('is-finishing');
    this.bar.parentElement.classList.add(ok ? 'is-done' : 'is-error');
    this.paint(1);
  }
}
