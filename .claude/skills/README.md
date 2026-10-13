# Скилы Claude Code для этого проекта

Подключаются автоматически, когда Claude Code открывает репозиторий (`.claude/skills/`).
Взяты из [affaan-m/ECC](https://github.com/affaan-m/ECC) (коммит `b92f181`, лицензия MIT —
`LICENSE-ECC`); содержимое прочитано перед добавлением, исполняемого кода нет, кроме
`frontend-design-direction/scripts/check-evidence.js` (локальная проверка JSON-отчёта, без сети).

| Скил | Для чего |
|---|---|
| `frontend-design-direction` | Направление дизайна, состояния интерфейса (загрузка, пусто, ошибка…), проверка на разных экранах |
| `make-interfaces-feel-better` | Детали: анимации только transform/opacity, нажатие, зоны клика, переносы, tabular-nums |
| `accessibility` | WCAG 2.2: фокус, контраст, размеры целей, aria-live |
| `design-system` | Аудит визуальной согласованности, токены |
| `humanize-ui` | Тексты интерфейса: без лишних подзаголовков, пояснений очевидного и «машинных» оборотов (по мотивам humanizer, MIT) |

Не подключены (написаны под React/Next.js и `motion/react`, а интерфейс здесь — Vanilla JS):
`motion-foundations`, `motion-patterns`, `motion-advanced`, `frontend-patterns`, `frontend-a11y`.
Их принципы применены вручную: анимации только `transform`/`opacity`, `prefers-reduced-motion`.
