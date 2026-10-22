#!/usr/bin/env bash
# Обновление файлообменника на сервере одной командой:
#
#   sudo bash scripts/update.sh          # или: npm run update
#
# Первый раз (скрипта на сервере ещё нет), из папки файлообменника:
#   git fetch origin main && git show origin/main:scripts/update.sh | sudo bash
#
# Что делает:
#   1. переключается на ветку main (если сервер стоит на другой) и подтягивает её с GitHub;
#   2. ставит зависимости, только если поменялся package-lock.json;
#   3. перезапускает службу (systemd «file-manager» или pm2) и ждёт, пока сайт ответит;
#   4. печатает, что изменилось.
# Свои правки файлов на сервере не трогает: если они есть — останавливается и показывает их.
# .env и data/ не в git — обновление их не меняет.
#
# Переменные: BRANCH (по умолчанию main), SERVICE (по умолчанию file-manager).
set -euo pipefail
# Запуск из файла — переходим в папку проекта; через «git show origin/main:scripts/update.sh | bash»
# (первое обновление, когда скрипта на сервере ещё нет) — работаем в текущей папке.
if [ -f "${BASH_SOURCE[0]:-}" ]; then cd "$(dirname "${BASH_SOURCE[0]}")/.."; fi
[ -d .git ] && [ -f package.json ] || { echo "Запустите из папки файлообменника" >&2; exit 1; }
BRANCH="${BRANCH:-main}"
SERVICE="${SERVICE:-file-manager}"

say() { printf '\033[1;32m›\033[0m %s\n' "$*"; }
fail() { printf '\033[1;31m✗\033[0m %s\n' "$*" >&2; exit 1; }

# git и npm — от имени того, кому принадлежит репозиторий (.git): так файлы после обновления
# остаются у того же владельца. Папка проекта и .git могут принадлежать разным пользователям
# (папку создала панель, а клонировали от root) — поэтому смотрим именно на .git.
OWNER="$(stat -c %U .git)"
AS=()
if [ "$(id -u)" = 0 ] && [ "$OWNER" != root ]; then AS=(sudo -u "$OWNER" -H); fi
# «dubious ownership»: git отказывается работать, если папка и .git у разных владельцев —
# разрешаем ровно эту папку (только для этих команд, глобальные настройки не меняются).
HERE="$(pwd -P)"
run() {
  if [ "$1" = git ]; then shift; set -- git -c safe.directory="$HERE" "$@"; fi
  "${AS[@]}" "$@"
}

before="$(run git rev-parse HEAD)"
current="$(run git rev-parse --abbrev-ref HEAD)"
say "Сейчас: ветка $current, версия $(run git log -1 --format='%h от %cd' --date=format:'%d.%m.%Y %H:%M')"

run git fetch --prune origin "$BRANCH" || fail "Не удалось получить обновления с GitHub (сеть, доступ к репозиторию?)"

if [ "$current" != "$BRANCH" ]; then
  say "Переключаюсь на ветку $BRANCH (сервер стоял на «$current»)"
  if run git show-ref --verify --quiet "refs/heads/$BRANCH"; then run git checkout "$BRANCH"
  else run git checkout -b "$BRANCH" --track "origin/$BRANCH"; fi
fi

if [ -n "$(run git status --porcelain --untracked-files=no)" ]; then
  run git status --short --untracked-files=no
  fail "На сервере изменены файлы проекта (выше). Сохраните их или верните: git checkout -- <файл>"
fi
run git merge --ff-only "origin/$BRANCH" >/dev/null || fail "Ветка $BRANCH на сервере разошлась с GitHub — нужна ручная проверка (git status)"
after="$(run git rev-parse HEAD)"

if [ ! -d node_modules ] || ! run git diff --quiet "$before" "$after" -- package-lock.json; then
  say "Ставлю зависимости (npm ci --omit=dev)…"
  run npm ci --omit=dev --no-audit --no-fund
fi

# Перезапуск
if command -v systemctl >/dev/null && systemctl list-unit-files "$SERVICE.service" 2>/dev/null | grep -q "$SERVICE.service"; then
  say "Перезапускаю службу $SERVICE…"
  if [ "$(id -u)" = 0 ]; then systemctl restart "$SERVICE"; else sudo systemctl restart "$SERVICE"; fi
elif command -v pm2 >/dev/null; then
  say "Перезапускаю pm2 $SERVICE…"
  run pm2 restart "$SERVICE" >/dev/null
else
  fail "Не нашёл службу $SERVICE (systemd или pm2) — перезапустите приложение вручную"
fi

# Порт: настройки из интерфейса (data/settings.json) → .env → 3000
PORT="$(node -e '
  const fs = require("fs");
  let p;
  try { p = JSON.parse(fs.readFileSync("data/settings.json", "utf8")).overrides?.PORT; } catch {}
  if (!p) try { p = /^\s*PORT\s*=\s*(\d+)/m.exec(fs.readFileSync(".env", "utf8"))?.[1]; } catch {}
  console.log(p || 3000);
' 2>/dev/null || echo 3000)"
for _ in $(seq 30); do
  if curl -fsS --noproxy '*' -o /dev/null "http://127.0.0.1:$PORT/healthz" 2>/dev/null; then ok=1; break; fi
  sleep 0.5
done
[ "${ok:-}" ] || fail "Приложение не ответило на порту $PORT. Журнал: journalctl -u $SERVICE -n 50"

if [ "$before" = "$after" ]; then
  say "Готово: обновлений не было, приложение перезапущено"
else
  say "Готово: $(run git log -1 --format='%h от %cd' --date=format:'%d.%m.%Y %H:%M'). Что нового:"
  run git log --format='   • %s' "$before..$after" --no-merges | head -30
fi
echo "  Если в браузере старый вид — обновите страницу с Ctrl+F5 (один раз после этого обновления)."
