# Файлообменник на S3

Лёгкий self-hosted файлообменник: Node.js (Express 5) + AWS SDK v3 + Tailwind CSS + Vanilla JS.
Загрузка и скачивание идут **напрямую между браузером и S3** по presigned URL — VDS только
подписывает ссылки, поэтому ему хватает ~80–90 МБ ОЗУ и почти не нужен канал.

![Диск с предпросмотром](docs/screenshots/disk-light.png)

## Возможности

- **Левая панель:** «Главная», «Пользователи», «Настройки» и дерево папок диска
  (ленивая подгрузка, раскрытие пути до текущей папки).
- **Диск:** папки (создание, удаление со всем содержимым), хлебные крошки, поиск в папке,
  drag-and-drop в любое место страницы, очередь загрузок с прогрессом, скоростью и отменой.
- **Переименование и перемещение файлов:** меню «⋯» у файла, кнопки в панели предпросмотра,
  клавиша F2, окно выбора папки, перетаскивание файла на папку в списке, в дереве или в
  хлебных крошках. Копирование выполняется внутри S3 (`CopyObject`, для файлов > 5 ГБ —
  `UploadPartCopy`), байты через VDS не идут.
- **Предпросмотр справа:** изображения, видео, аудио, PDF, текст и код (первые 256 КБ),
  свойства файла, «Скачать», «Скопировать ссылку», «Удалить». На телефоне — выезжающая панель.
- **Главная:** сводка (файлы, занятое место, папки, пользователи), структура хранилища по типам,
  недавние файлы.
- **Пользователи и роли:** «Просмотр», «Редактор», «Администратор»; без БД — `data/users.json`.
- **Настройки:** смена пароля, тема (системная/светлая/тёмная), срок ссылок по умолчанию,
  сведения о хранилище и проверка подключения к S3 (для администратора).
- Файлы до `MULTIPART_THRESHOLD_MB` — одним PUT; крупнее — **multipart** частями
  (3 параллельно, повтор упавших частей), до 5 ТБ.

| Главная | Пользователи | Тёмная тема |
|---|---|---|
| ![](docs/screenshots/home-light.png) | ![](docs/screenshots/users.png) | ![](docs/screenshots/disk-dark.png) |

## Архитектура

```
Браузер ──(1) POST /api/uploads ─────────▶ Node.js ──(создать multipart / подписать)──▶ S3 API
   │    ◀─────────── presigned PUT URL ───────┘
   ├──(2) PUT файл напрямую ─────────────────────────────────────────────────────────▶ S3
   ├──(3) POST /api/uploads/complete ──────▶ Node.js ──(HEAD/ListParts, проверка размера)▶ S3
   └──(4) POST /api/files/link ────────────▶ Node.js → presigned GET → браузер качает с S3
```

## Хранение в S3

Папка — это S3-префикс (пустая папка хранится как объект-маркер `путь/`). Файл лежит прямо
в своей папке: `uploads/<папка>/<время-по-убыванию>-<случайный id>~<имя>`. Инвертированное
время даёт сортировку «новые сверху» прямо в `ListObjectsV2`, случайный id делает ключ неугадываемым.

В S3 нет операции «переименовать»: файл копируется под новым ключом и исходный удаляется.
Id в ключе при этом сохраняется, поэтому файл остаётся на своём месте в списке. Ссылки,
выданные на старый ключ, после переименования или перемещения перестают работать.

## Структура проекта

```
├── src/
│   ├── server.js              # Express: middleware, роуты, статика, graceful shutdown
│   ├── config.js              # загрузка и валидация .env
│   ├── s3.js                  # S3-клиент (AWS SDK v3), листинг папок, presigned URL
│   ├── keys.js                # ключи и папки, санитизация имён, белый список предпросмотра
│   ├── users.js               # пользователи и роли (data/users.json)
│   ├── auth.js                # сессии (HMAC-токен в cookie), requireAuth / requireRole
│   ├── password.js            # scrypt-хеширование пароля
│   ├── middleware/security.js # helmet/CSP, проверка Origin, rate limit, обработчик ошибок
│   └── routes/
│       ├── auth.js            # вход/выход, профиль, смена пароля
│       ├── files.js           # папки, файлы, загрузка, предпросмотр, статистика
│       ├── users.js           # управление пользователями (админ)
│       └── settings.js        # сведения о хранилище, проверка подключения (админ)
├── public/                    # фронтенд (сборка на сервере не нужна)
│   ├── index.html, login.html, favicon.svg
│   ├── css/app.css            # собранный Tailwind (коммитится)
│   └── js/
│       ├── app.js             # оболочка: роутер, левая панель, очередь загрузок
│       ├── tree.js            # дерево папок
│       ├── folder-picker.js   # окно выбора папки для перемещения
│       ├── preview.js         # правая панель предпросмотра
│       ├── views/             # home.js, disk.js, users.js, settings.js
│       ├── api.js, uploader.js, ui.js, theme.js, login.js
├── frontend/tailwind.css      # исходник стилей
├── scripts/                   # hash-password.js, apply-cors.js
├── deploy/                    # nginx.conf.example, file-manager.service, s3-cors.json, s3-lifecycle.json
├── docs/DEPLOY_FASTPANEL.md   # пошаговый деплой
├── test/                      # node --test
├── ecosystem.config.cjs       # PM2
└── .env.example
```

## API

Все маршруты, кроме входа, требуют сессии. Изменяющие запросы принимаются только с `APP_ORIGIN`.
Роль: 👁 — любой вошедший, ✏️ — редактор и выше, 🔑 — администратор.

| Метод | Путь | Роль | Описание |
|---|---|---|---|
| POST | `/api/auth/login` | — | `{username, password}` → cookie сессии |
| POST | `/api/auth/logout` | — | выход |
| GET | `/api/auth/me` | 👁 | текущий пользователь |
| POST | `/api/auth/password` | 👁 | `{currentPassword, newPassword}` |
| GET | `/api/stats` | 👁 | сводка: файлы, размер, типы, недавние |
| GET | `/api/files?folder=a/b/&cursor=` | 👁 | `{folders, files, nextCursor}` |
| POST | `/api/files/link` | 👁 | `{key, ttl: 3600\|86400\|604800}` → ссылка на скачивание |
| POST | `/api/files/preview` | 👁 | `{key}` → `{kind, url, size, contentType}` (inline, 15 мин) |
| POST | `/api/folders` | ✏️ | `{parent, name}` — создать папку |
| POST | `/api/folders/delete` | ✏️ | `{path}` — удалить папку рекурсивно |
| POST | `/api/uploads` | ✏️ | `{name, size, type, folder}` → single PUT или multipart |
| POST | `/api/uploads/parts` | ✏️ | `{key, uploadId, partNumbers[]}` → presigned URL частей |
| POST | `/api/uploads/complete` | ✏️ | `{key, uploadId?}` — завершить и проверить размер |
| POST | `/api/uploads/abort` | ✏️ | `{key, uploadId}` |
| POST | `/api/files/move` | ✏️ | `{key, folder?, name?}` — переименовать и/или переместить |
| DELETE | `/api/files?key=` | ✏️ | удалить файл |
| GET/POST | `/api/users`, PATCH/DELETE `/api/users/:username` | 🔑 | пользователи и роли |
| GET | `/api/settings/storage`, POST `/api/settings/storage/check` | 🔑 | сведения о S3, проверка |

## Локальный запуск

```bash
npm install
cp .env.example .env              # APP_ORIGIN=http://localhost:3000, данные S3
npm run hash-password             # → ADMIN_PASSWORD_HASH (первый администратор)
npm run s3:cors                   # CORS для бакета
npm run dev                       # http://localhost:3000
npm run watch:css                 # если меняете вёрстку
npm test
```

После изменения HTML/JS выполните `npm run build:css` и закоммитьте `public/css/app.css`.

## Деплой

См. **[docs/DEPLOY_FASTPANEL.md](docs/DEPLOY_FASTPANEL.md)** — создание сайта в FastPanel,
Nginx reverse proxy, PM2 / systemd, SSL, CORS бакета.
