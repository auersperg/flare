# Flare 0.3.7 — отчёт об упрощении

Дата: 13 октября 2026 года. Исходная опубликованная версия: 0.3.6.
Статус: код реализован; release/cloud/UI проверки выполняются. Этот отчёт — evidence, не второй operating guide.

## 1. Создание проекта

Убрано обязательное поле Customer/workspace. Новый пользователь вводит название, необязательный URL alias и origins. API использует `Default`, если customer не передан; явное старое значение по-прежнему валидируется. Существующая D1 группировка, UUID и связи не мигрируются и не удаляются. Название и origins продолжают проверяться, права на создание не меняются.

## 2. Таблицы и schema

Удалены TableGuide и генератор schemaDraft, кнопки Add/Edit table в Data/Schema. Схема определяется в application code и по-прежнему валидируется при deployment. Панель показывает contract и indexes; Add/Edit/Delete row, типизированные формы документов, pagination и production confirmation сохранены. Удалены только тесты удалённого draft-конструктора; добавлены регрессии нового UX.

## 3. Health

Удалены пустой Insights и дублирующие карточки счётчиков. Основной экран показывает статус, cloud URL, текущий application hash и компактные connections/subscriptions. Connect SDK сохранён. History/rollback доступны в нативном закрытом details, а не раскрытой таблицей на основном экране. Backend release history и пять сохранённых версий не удалены.

## 4. Запросы

Единственный Health resource принадлежит HealthView; ReleaseList принимает active как prop. History загружается только при раскрытии details. Обязательный pre-mutation read целевой среды сохранён для expected-hash/CAS, это не дубль первоначальной загрузки. Не добавлены query cache, polling, event bus или отдельный state framework. Backup UI тоже монтируется только при раскрытии Settings → Backups; восстановление и private copies не удаляются.

## 5. Документация

Три актуальных документа: [архитектура](../architecture.md), [install/update](../platform-lifecycle.md), [runbook](../production-runbook.md). Удалён дублирующий краткий architecture index. Maintenance, packaging, Cloudflare product catalogue и законченный переход A–G перенесены в явно обозначенный исторический archive; release checkpoints вынесены из текущего command guide. README — входная точка; инструкции direct deploy удалены. Регрессия проверяет Markdown links/anchors рекурсивно, включая archive.

## 6. Legacy

Удалены исполняемый setup-cloud и два ручных Wrangler example configs. Настройки создаёт только существующий managed lifecycle generator. Проверки generator/bindings/secret separation/native namespace/Queues сохранены и направлены на реальную managed configuration, а не на копии. Private recovery artifacts, scoped token, published old archives, namespace/resource names и storage/wire identifiers сохраняются: это действующие данные/совместимость, а не неиспользуемый legacy.

## Проверки и выпуск

- Targeted regression/type checks: PASS; удалённый функционал заменён проверками нового UX.
- Clean frozen build, package/native acceptance и reproducibility: PASS. Archive SHA-256 `17e7ed76c7b647cb87a0051068281b3a12731ae3dd960c19b2697fe807839975`; platform digest `c2ae421b7cc9a62dc068cd5ed5789cdcedc588e8ba984d84bc4fed5f7851fe9c`.
- Cross-version 0.3.6 → 0.3.7: выполняется перед publication.
- Protected npm publication под next, latest не менять: подтверждено владельцем, выполняется после gates.
- Personal published-CLI update, owner UI, data/file/auth/resource preservation и no-op: выполняются после publication.

Никаких новых сервисов, фоновых таймеров, замен namespace, удаления приложений или data rewind. Backup/restore, jobs, permissions и lifecycle safeguards сохранены.
