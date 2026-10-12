#!/usr/bin/env bash
# Установка файлообменника как службы systemd.
#
#   sudo bash deploy/install-systemd.sh                 # установить и запустить
#   sudo bash deploy/install-systemd.sh --dry-run       # только показать готовый юнит
#   sudo bash deploy/install-systemd.sh --uninstall     # остановить и удалить службу
#
# Параметры (необязательно, определяются автоматически):
#   --user ИМЯ      пользователь, от которого работает приложение (по умолчанию — владелец каталога)
#   --dir  ПУТЬ     каталог приложения (по умолчанию — каталог этого репозитория)
#   --node ПУТЬ     путь к node (по умолчанию — node из PATH этого пользователя, в т.ч. nvm)
#   --name ИМЯ      имя службы (по умолчанию file-manager)
set -euo pipefail

NAME=file-manager
APP_DIR=""
APP_USER=""
NODE_BIN=""
DRY_RUN=0
UNINSTALL=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --user) APP_USER="$2"; shift 2 ;;
    --dir) APP_DIR="$2"; shift 2 ;;
    --node) NODE_BIN="$2"; shift 2 ;;
    --name) NAME="$2"; shift 2 ;;
    --dry-run) DRY_RUN=1; shift ;;
    --uninstall) UNINSTALL=1; shift ;;
    -h|--help) sed -n '2,15p' "$0"; exit 0 ;;
    *) echo "Неизвестный параметр: $1" >&2; exit 2 ;;
  esac
done

say()  { printf '\033[1;32m›\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m!\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[1;31m✗\033[0m %s\n' "$*" >&2; exit 1; }

UNIT_PATH="/etc/systemd/system/${NAME}.service"

if [[ $UNINSTALL -eq 1 ]]; then
  [[ $EUID -eq 0 ]] || die "Запустите через sudo"
  systemctl disable --now "$NAME" 2>/dev/null || true
  rm -f "$UNIT_PATH"
  systemctl daemon-reload
  say "Служба $NAME удалена (файлы приложения и data/ не тронуты)."
  exit 0
fi

[[ $DRY_RUN -eq 1 || $EUID -eq 0 ]] || die "Запустите через sudo: sudo bash $0"

# Каталог приложения: по умолчанию — корень репозитория, где лежит этот скрипт.
APP_DIR="${APP_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
APP_DIR="$(cd "$APP_DIR" && pwd)"
[[ -f "$APP_DIR/src/server.js" ]] || die "В $APP_DIR нет src/server.js — укажите каталог приложения: --dir ПУТЬ"
[[ -f "$APP_DIR/deploy/file-manager.service" ]] || die "Не найден шаблон $APP_DIR/deploy/file-manager.service"

# Пользователь: владелец каталога (в FastPanel — пользователь сайта). Не root.
APP_USER="${APP_USER:-$(stat -c %U "$APP_DIR")}"
id "$APP_USER" >/dev/null 2>&1 || die "Пользователь $APP_USER не существует"
[[ "$APP_USER" != "root" ]] || die "Не запускайте приложение от root. Укажите пользователя сайта: --user ИМЯ (и сделайте его владельцем $APP_DIR)"
APP_GROUP="$(id -gn "$APP_USER")"

# node: из PATH пользователя (login-shell подхватывает nvm), иначе системный.
if [[ -z "$NODE_BIN" ]]; then
  NODE_BIN="$(sudo -u "$APP_USER" -i bash -lc 'command -v node' 2>/dev/null || true)"
  [[ -n "$NODE_BIN" ]] || NODE_BIN="$(command -v node || true)"
fi
[[ -n "$NODE_BIN" && -x "$NODE_BIN" ]] || die "Не найден node. Установите Node.js 20.12+ или укажите путь: --node /path/to/node"
NODE_BIN="$(readlink -f "$NODE_BIN")"
NODE_VER="$("$NODE_BIN" -p 'process.versions.node')"
"$NODE_BIN" -e 'const [a,b]=process.versions.node.split(".").map(Number); process.exit(a>20||(a===20&&b>=12)?0:1)' \
  || die "Нужен Node.js 20.12 или новее, найден $NODE_VER ($NODE_BIN)"

# ProtectHome: если приложение или node лежат в /home или /root (например, nvm) —
# делаем домашние каталоги доступными только для чтения, иначе — полностью скрываем.
PROTECT_HOME=true
case "$APP_DIR/:$NODE_BIN" in *"/home/"*|*"/root/"*) PROTECT_HOME=read-only ;; esac

UNIT="$(sed -e "s|@USER@|$APP_USER|g" -e "s|@GROUP@|$APP_GROUP|g" -e "s|@APP_DIR@|$APP_DIR|g" \
            -e "s|@NODE@|$NODE_BIN|g" -e "s|@PROTECT_HOME@|$PROTECT_HOME|g" "$APP_DIR/deploy/file-manager.service")"

if [[ $DRY_RUN -eq 1 ]]; then
  echo "$UNIT"
  exit 0
fi

say "Приложение: $APP_DIR"
say "Пользователь: $APP_USER:$APP_GROUP"
say "Node.js: $NODE_VER ($NODE_BIN)"

# Проверки перед запуском.
[[ -f "$APP_DIR/.env" ]] || die "Нет $APP_DIR/.env — создайте его по .env.example (нужны APP_ORIGIN и ADMIN_PASSWORD_HASH)"
grep -q '^APP_ORIGIN=' "$APP_DIR/.env" || warn "В .env нет APP_ORIGIN — приложение не запустится"
[[ -d "$APP_DIR/node_modules/@aws-sdk/client-s3" ]] || die "Не установлены зависимости: cd $APP_DIR && sudo -u $APP_USER npm ci --omit=dev"
if command -v pm2 >/dev/null && sudo -u "$APP_USER" -i pm2 jlist 2>/dev/null | grep -q '"name":"file-manager"'; then
  warn "Приложение уже запущено через PM2 — остановите его, иначе будет конфликт порта: sudo -u $APP_USER -i pm2 delete file-manager && pm2 save"
fi

# Каталог данных: единственное место, куда приложению разрешено писать.
install -d -m 700 -o "$APP_USER" -g "$APP_GROUP" "$APP_DIR/data"
chown "$APP_USER:$APP_GROUP" "$APP_DIR/.env" && chmod 600 "$APP_DIR/.env"
find "$APP_DIR/data" -maxdepth 1 -type f -exec chown "$APP_USER:$APP_GROUP" {} + -exec chmod 600 {} +

echo "$UNIT" > "$UNIT_PATH"
chmod 644 "$UNIT_PATH"
command -v systemd-analyze >/dev/null && systemd-analyze verify "$UNIT_PATH" 2>&1 | grep -v "^$" | sed 's/^/  /' || true

systemctl daemon-reload
systemctl enable "$NAME" >/dev/null
systemctl restart "$NAME"
sleep 2

if systemctl is-active --quiet "$NAME"; then
  PORT="$(grep -E '^PORT=' "$APP_DIR/.env" | tail -1 | cut -d= -f2 | tr -d "'\" ")"
  PORT="${PORT:-3000}"
  if command -v curl >/dev/null && curl -fsS -m 3 "http://127.0.0.1:${PORT}/healthz" >/dev/null 2>&1; then
    say "Служба $NAME запущена и отвечает на http://127.0.0.1:${PORT}/healthz"
  else
    say "Служба $NAME запущена (порт мог быть изменён в настройках интерфейса)"
  fi
  echo
  echo "  Статус:     systemctl status $NAME"
  echo "  Логи:       journalctl -u $NAME -f"
  echo "  Перезапуск: systemctl restart $NAME"
  echo "  Память:     systemctl show $NAME -p MemoryCurrent"
else
  warn "Служба не запустилась. Последние строки журнала:"
  journalctl -u "$NAME" -n 30 --no-pager || true
  exit 1
fi
