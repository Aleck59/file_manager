# Деплой на VDS с FastPanel

Инструкция рассчитана на сервер с небольшим объёмом ОЗУ: на сервере ничего не собирается
(CSS уже скомпилирован и лежит в репозитории), Node.js работает одним процессом с
ограничением памяти (~80–90 МБ RSS), а файлы идут напрямую между браузером и S3.

Далее по тексту:
- `files.example.com` — ваш домен;
- `USER` — системный пользователь сайта, которого создаёт FastPanel;
- `/var/www/USER/data/www/files.example.com` — каталог сайта (`APP_DIR`).

---

## 0. Подготовка (один раз)

### 0.1. Swap, если ОЗУ ≤ 1 ГБ

`npm ci` на маленьком сервере может упасть по нехватке памяти. Добавьте 1 ГБ swap:

```bash
sudo fallocate -l 1G /swapfile && sudo chmod 600 /swapfile
sudo mkswap /swapfile && sudo swapon /swapfile
echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
```

### 0.2. Node.js 20.12+ (рекомендуется 22 LTS)

Проверьте: `node -v`. Если Node.js нет или он старше 20.12, поставьте системно (NodeSource):

```bash
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs
node -v   # v22.x
```

> В новых версиях FastPanel есть раздел **«Приложения» / «Node.js»** с выбором версии —
> можно использовать его вместо NodeSource. Главное, чтобы `node` был ≥ 20.12.

### 0.3. DNS

Создайте A-запись `files.example.com` → IP вашего VDS.

---

## 1. Создание сайта в FastPanel

1. **Сайты → Создать сайт** (или «Добавить сайт»).
2. Домен: `files.example.com`. Псевдоним `www` не нужен.
3. Владелец — новый или существующий пользователь (это и есть `USER`).
4. **Обработчик / тип сайта.** Здесь три варианта, в зависимости от версии FastPanel:
   - есть тип **«Node.js»** — выберите его, укажите стартовый файл `src/server.js` и порт `3000`.
     FastPanel сам будет держать процесс и проксировать запросы; тогда шаги 5 и 6 можно
     пропустить — но всё равно задайте переменные окружения (шаг 4) и проверьте, что в
     настройках приложения есть флаги `--max-old-space-size=96 --max-semi-space-size=2`;
   - есть **«Reverse proxy» / «Проксирование»** — выберите его и укажите backend
     `http://127.0.0.1:3000`. Шаг 5 сводится к проверке конфигурации;
   - есть только **PHP/статический сайт** — выберите «Статический сайт» (без PHP, чтобы не
     тратить память на PHP-FPM); проксирование настроим вручную в шаге 5.
5. Создайте сайт.
6. **SSL:** вкладка сайта **«SSL-сертификаты» → «Let's Encrypt»** → выпустить, затем включите
   **«Перенаправление HTTP → HTTPS»**. HTTPS обязателен: cookie сессии ставится с флагом
   `Secure` и префиксом `__Host-`.

---

## 2. Код на сервер

Подключитесь по SSH и работайте от имени пользователя сайта, а не root:

```bash
sudo -iu USER                        # или ssh USER@server
cd /var/www/USER/data/www/files.example.com
# Каталог должен быть пустым. FastPanel кладёт туда заглушку — посмотрите и удалите её:
ls -la
rm -f index.html
git clone https://github.com/aleck59/file_manager.git .
npm ci --omit=dev                    # только runtime-зависимости, без tailwind
```

> Репозиторий приватный? Создайте deploy key: `ssh-keygen -t ed25519 -f ~/.ssh/fm_deploy -N ''`,
> добавьте `~/.ssh/fm_deploy.pub` в GitHub → Settings → Deploy keys (read-only) и клонируйте
> через `GIT_SSH_COMMAND='ssh -i ~/.ssh/fm_deploy' git clone git@github.com:aleck59/file_manager.git .`

---

## 3. S3: бакет, CORS и автоочистка

1. В панели S3-провайдера создайте **приватный** бакет (публичный доступ не нужен — все
   ссылки подписанные) и ключ доступа, ограниченный этим бакетом.
2. **CORS обязателен** — без него браузер заблокирует прямую загрузку в S3.
   После заполнения `.env` (шаг 4) выполните:

   ```bash
   npm run s3:cors            # применит правила для APP_ORIGIN
   npm run s3:cors -- --show  # проверка
   ```

   Если провайдер не поддерживает настройку CORS через API — внесите правила из
   `deploy/s3-cors.json` в его панели, заменив `https://files.example.com` на ваш домен.
   Разрешены только ваш Origin и методы `GET`, `PUT`, `HEAD`.
3. **Lifecycle (рекомендуется):** правило из `deploy/s3-lifecycle.json` удаляет брошенные
   multipart-загрузки через 2 дня (например, если вкладку закрыли посреди загрузки).
   Через AWS CLI: `aws s3api put-bucket-lifecycle-configuration --bucket BUCKET
   --endpoint-url ENDPOINT --lifecycle-configuration file://deploy/s3-lifecycle.json`
   или в панели провайдера.

---

## 4. Конфигурация `.env`

```bash
cp .env.example .env
chmod 600 .env
npm run hash-password          # введите пароль (≥ 10 символов) — получите ADMIN_PASSWORD_HASH
openssl rand -hex 32           # это SESSION_SECRET
nano .env
```

Обязательно заполните: `APP_ORIGIN=https://files.example.com`, `ADMIN_USERNAME` и
`ADMIN_PASSWORD_HASH` (в одинарных кавычках — в хеше есть символ `$`), `SESSION_SECRET`, все `S3_*`.

Создайте каталог для данных приложения (там будет `users.json` со списком пользователей):

```bash
mkdir -p data && chmod 700 data
```

При первом запуске из `ADMIN_USERNAME` / `ADMIN_PASSWORD_HASH` создаётся администратор.
Дальше пользователи, роли и пароли управляются в интерфейсе (**Пользователи**, **Настройки**),
а значения в `.env` больше не используются.

> **Восстановление доступа**, если пароль администратора утерян: остановите приложение,
> удалите `data/users.json` (остальные пользователи тоже удалятся), задайте новый
> `ADMIN_PASSWORD_HASH` и запустите приложение — администратор создастся заново.

| Провайдер | `S3_ENDPOINT` | `S3_REGION` | `S3_FORCE_PATH_STYLE` |
|---|---|---|---|
| Yandex Object Storage | `https://storage.yandexcloud.net` | `ru-central1` | `true` |
| Selectel | `https://s3.ru-1.storage.selcloud.ru` | `ru-1` | `true` |
| Timeweb Cloud | `https://s3.timeweb.cloud` | `ru-1` | `true` |
| VK Cloud | `https://hb.ru-msk.vkcloud-storage.ru` | `ru-msk` | `true` |
| Cloudflare R2 | `https://<account_id>.r2.cloudflarestorage.com` | `auto` | `true` |
| MinIO (свой) | `https://minio.example.com` | `us-east-1` | `true` |

Уточняйте endpoint и регион в документации вашего провайдера.

Проверка запуска вручную:

```bash
npm start
# в другом терминале:
curl -s http://127.0.0.1:3000/healthz   # {"ok":true}
```

Остановите `Ctrl+C`.

---

## 5. Nginx: обратный прокси на Node.js

Приложение слушает только `127.0.0.1:3000` — наружу его отдаёт Nginx FastPanel.

1. **Сайты → files.example.com → «Конфигурация»** (иконка шестерёнки / «Изменить конфигурацию»)
   → вкладка **Nginx**.
2. В блоке `server { ... }` для порта 443 найдите `location / { ... }` (и, если есть,
   `location @fallback` / проксирование на Apache или `fastcgi_pass` на PHP) и замените на
   содержимое `deploy/nginx.conf.example`, подставив свой путь вместо
   `/var/www/USER/data/www/files.example.com`.
3. Сохраните — FastPanel проверит конфигурацию (`nginx -t`) и перезагрузит Nginx.
   Если в вашей версии правка основного конфига недоступна, используйте поле
   **«Дополнительные директивы»** в том же разделе.

Ключевые моменты конфигурации:
- `proxy_pass http://127.0.0.1:3000;` — запросы уходят в Node.js;
- `X-Forwarded-For` / `X-Forwarded-Proto` — приложение видит реальный IP (нужно для
  ограничения попыток входа) — за это отвечает `TRUST_PROXY=1` в `.env`;
- `client_max_body_size 64k;` — файлы через сервер не идут, большие тела не нужны;
- `/css/` и `/js/` Nginx отдаёт сам, не дёргая Node.js.

> Если включаете кэширование в FastPanel — **не кэшируйте** `/api/` и `/`:
> API отдаёт `Cache-Control: no-store`, но серверный кэш Nginx может это проигнорировать.

---

## 6. Запуск в фоне

### Вариант А — PM2 (проще, привычнее)

```bash
# от root (или sudo) — один раз
npm install -g pm2

# от пользователя сайта
sudo -iu USER
cd /var/www/USER/data/www/files.example.com
mkdir -p logs
pm2 start ecosystem.config.cjs
pm2 save
pm2 startup          # выведет команду с sudo — выполните её от root, чтобы PM2 стартовал после перезагрузки
```

Полезное: `pm2 status`, `pm2 logs file-manager`, `pm2 restart file-manager`, `pm2 monit`.
Ротация логов, чтобы они не съели диск:
`pm2 install pm2-logrotate && pm2 set pm2-logrotate:max_size 10M && pm2 set pm2-logrotate:retain 5`.

`ecosystem.config.cjs` уже настроен под малую ОЗУ: 1 процесс в режиме fork, лимит кучи V8 96 МБ,
автоперезапуск при превышении 160 МБ.

### Вариант Б — systemd (рекомендуется при очень малой ОЗУ)

Демон PM2 сам по себе занимает 40–60 МБ. systemd уже есть в системе и ничего не добавляет:

```bash
sudo cp deploy/file-manager.service /etc/systemd/system/file-manager.service
sudo sed -i 's/USER/ваш_пользователь/g; s/files.example.com/ваш_домен/g' /etc/systemd/system/file-manager.service
which node   # если путь не /usr/bin/node — поправьте ExecStart
sudo systemctl daemon-reload
sudo systemctl enable --now file-manager
systemctl status file-manager
journalctl -u file-manager -f      # логи
```

Юнит запускает процесс от пользователя сайта, ограничивает память cgroup-ом (`MemoryMax=180M`)
и включает песочницу systemd (`ProtectSystem=strict`, `NoNewPrivileges` и др.). Писать
приложению разрешено только в каталог `data/` (`ReadWritePaths`) — он должен существовать
до запуска (шаг 4).

### Вариант В — средства FastPanel

Если сайт создан с типом «Node.js» (шаг 1), FastPanel сам запускает и перезапускает процесс.
Не запускайте приложение одновременно ещё и через PM2/systemd — будет конфликт порта.

---

## 7. Проверка

1. Откройте `https://files.example.com` → перенаправит на `/login`.
2. Войдите (логин из `ADMIN_USERNAME`), откройте **Диск**, создайте папку, перетащите файл →
   прогресс-бар → файл появляется в списке, по клику — предпросмотр справа.
3. «Скопировать ссылку» → откройте ссылку в приватном окне — файл скачивается с домена S3.
4. Если загрузка падает с ошибкой «Нет ответа от S3» — это CORS (шаг 3): проверьте, что
   `AllowedOrigins` в точности совпадает с `APP_ORIGIN` (схема, домен, без `/` в конце).
5. Если сразу после входа снова открывается `/login` — сайт открыт по `http`, а не `https`,
   или `APP_ORIGIN` не совпадает с адресом в браузере.

---

## 8. Обновление

```bash
sudo -iu USER
cd /var/www/USER/data/www/files.example.com
git pull
npm ci --omit=dev
pm2 restart file-manager        # или: sudo systemctl restart file-manager
```

---

## 9. Безопасность — чек-лист

- [x] Доступ к интерфейсу и API — только после входа (scrypt-хеши паролей, HttpOnly + Secure + SameSite=Strict cookie).
- [x] Роли: «Просмотр» (смотреть и скачивать), «Редактор» (+ загрузка, папки, удаление),
      «Администратор» (+ пользователи и сведения о хранилище). Права проверяются на сервере.
- [x] Смена пароля или удаление пользователя сразу завершает его сессии.
- [x] Предпросмотр: тип ответа S3 задаёт сервер по белому списку; HTML, JS и прочий текст
      отдаются как `text/plain` и никогда не исполняются.
- [x] Защита от перебора: 10 попыток входа за 15 минут с IP.
- [x] CSRF: изменяющие запросы принимаются только с `APP_ORIGIN`.
- [x] CSP, X-Frame-Options, nosniff, Referrer-Policy (helmet).
- [x] Сервер сам генерирует ключи объектов; ключи от клиента проверяются по строгому шаблону —
      через API нельзя тронуть объекты бакета вне `S3_PREFIX`.
- [x] Скачивание всегда с `Content-Disposition: attachment` — загруженный HTML/SVG не исполнится.
- [x] Лимит размера проверяется после загрузки; превысившие объекты удаляются.
- [x] Node.js слушает только `127.0.0.1`.
- [ ] Ключ S3 — с правами только на этот бакет.
- [ ] `.env` с правами `600`, `data/` с правами `700`; оба не попадают в git (`.gitignore`).
- [ ] Включите резервное копирование `data/users.json` (вместе с бэкапами сайта в FastPanel).
- [ ] Порт 3000 закрыт файрволом снаружи (FastPanel → «Файрвол» или `ufw deny 3000`).
- [ ] Чтобы мгновенно отозвать все сессии — смените `SESSION_SECRET` и перезапустите приложение.
