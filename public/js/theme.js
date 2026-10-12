// Подключается синхронно в <head>, чтобы тема применилась до отрисовки (без «мигания»).
(function () {
  var pref = 'system';
  try { pref = localStorage.getItem('fm-theme') || 'system'; } catch (e) { /* приватный режим */ }
  var dark = pref === 'dark' || (pref === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
})();
