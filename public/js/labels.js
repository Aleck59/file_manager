// Цветные метки файлов и папок: палитра, точка-индикатор и меню выбора.
import { api } from './api.js';
import { h, icon, openMenu, toast } from './ui.js';

export const LABELS = [
  ['red', 'Красная', 'bg-rose-500'],
  ['orange', 'Оранжевая', 'bg-orange-500'],
  ['yellow', 'Жёлтая', 'bg-amber-400'],
  ['green', 'Зелёная', 'bg-emerald-500'],
  ['blue', 'Синяя', 'bg-sky-500'],
  ['purple', 'Фиолетовая', 'bg-violet-500'],
  ['gray', 'Серая', 'bg-slate-400'],
];
const BY_ID = Object.fromEntries(LABELS.map(([id, name, cls]) => [id, { name, cls }]));
export const labelName = (color) => BY_ID[color]?.name ?? '';

/** Точка метки рядом с именем (null — без метки). */
export function labelDot(color, size = 'h-2.5 w-2.5') {
  if (!BY_ID[color]) return null;
  return h('span', { class: `inline-block ${size} shrink-0 rounded-full ${BY_ID[color].cls}`, title: `Метка: ${BY_ID[color].name.toLowerCase()}`, role: 'img', 'aria-label': `Метка: ${BY_ID[color].name.toLowerCase()}` });
}

/**
 * Меню выбора метки. target — {key} файла или {folder} папки; item — объект списка
 * (у него обновится .label). onChange вызывается после сохранения.
 */
export function openLabelMenu(anchor, target, item, onChange) {
  const choose = async (color) => {
    try {
      await api.setLabel({ ...target, color });
      item.label = color ?? undefined;
      onChange?.(color);
    } catch (err) {
      toast(err.message, 'error');
    }
  };
  openMenu(anchor, [
    ...LABELS.map(([id, name, cls]) => ({
      label: item.label === id ? `${name} ✓` : name,
      lead: h('span', { class: 'flex h-4 w-4 items-center justify-center' }, h('span', { class: `h-3 w-3 rounded-full ${cls}` })),
      onSelect: () => choose(id),
    })),
    item.label && { label: 'Убрать метку', icon: 'close', onSelect: () => choose(null) },
  ]);
}

export const labelMenuItem = (anchorGetter, target, item, onChange) => ({
  label: 'Метка…',
  lead: item.label ? h('span', { class: 'flex h-4 w-4 items-center justify-center' }, labelDot(item.label, 'h-3 w-3')) : icon('tag'),
  onSelect: () => openLabelMenu(anchorGetter(), target, item, onChange),
});
