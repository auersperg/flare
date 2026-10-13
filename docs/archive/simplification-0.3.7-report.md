# Flare 0.3.7 — отчёт об упрощении

Дата: 13 октября 2026 года. Исходная опубликованная версия: 0.3.6.
Статус: все шесть пунктов выполнены, опубликованная 0.3.7 установлена и проверена в личной панели. Этот отчёт — evidence, не второй operating guide.

## 1. Создание проекта

Убрано обязательное поле Customer/workspace. Новый пользователь вводит название, необязательный URL alias и origins. API использует `Default`, если customer не передан; явное старое значение по-прежнему валидируется. Существующая D1 группировка, UUID и связи не мигрируются и не удаляются. Название и origins продолжают проверяться, права на создание не меняются.

## 2. Таблицы и schema

Удалены TableGuide и генератор schemaDraft, кнопки Add/Edit table в Data/Schema. Схема определяется в application code и по-прежнему валидируется при deployment. Панель показывает contract и indexes; Add/Edit/Delete row, типизированные формы документов, pagination и production confirmation сохранены. Удалены только тесты удалённого draft-конструктора; добавлены регрессии нового UX.

## 3. Health

Удалены пустой Insights и дублирующие карточки счётчиков. Основной экран показывает статус, cloud URL, текущий application hash и компактные connections/subscriptions. Connect SDK сохранён. History/rollback доступны в нативном закрытом details, а не раскрытой таблицей на основном экране. Backend release history и пять сохранённых версий не удалены.

## 4. Запросы

Единственный Health resource принадлежит HealthView; ReleaseList принимает active как prop. History загружается только при раскрытии details. Обязательный pre-mutation read целевой среды сохранён для expected-hash/CAS, это не дубль первоначальной загрузки. Не добавлены query cache, polling, event bus или отдельный state framework. Backup UI тоже монтируется только при раскрытии Settings → Backups, без второго Manage/Close toggle; восстановление и private copies не удаляются.

## 5. Документация

Три актуальных документа: [архитектура](../architecture.md), [install/update](../platform-lifecycle.md), [runbook](../production-runbook.md). Удалён дублирующий краткий architecture index. Maintenance, packaging, Cloudflare product catalogue и законченный переход A–G перенесены в явно обозначенный исторический archive; release checkpoints вынесены из текущего command guide. README — входная точка; инструкции direct deploy удалены. Регрессия проверяет Markdown links/anchors рекурсивно, включая archive.

## 6. Legacy

Удалены исполняемый setup-cloud и два ручных Wrangler example configs. Настройки создаёт только существующий managed lifecycle generator. Проверки generator/bindings/secret separation/native namespace/Queues сохранены и направлены на реальную managed configuration, а не на копии. Private recovery artifacts, scoped token, published old archives, namespace/resource names и storage/wire identifiers сохраняются: это действующие данные/совместимость, а не неиспользуемый legacy.

## Проверки и выпуск

- Targeted regression/type checks: PASS, 398 tests / 0 failures; удалённый функционал заменён проверками нового UX.
- Clean frozen build, package/native acceptance и reproducibility: PASS. Archive SHA-256 `0a7e3be367bbc9a95a681f15a922d40d0b6a55b87080c4110fb216cf58fdc659`; platform digest `e7c746146383646d2a33266f89c3a43ea0b1eff9167edbd9ccbeeb0f5432a15c`.
- Cross-version 0.3.6 → exact final 0.3.7: PASS; data, app release, native namespace/resources, signing key, password session, private file и pending job сохранены; scoped cleanup PASS.
- Protected npm publication под `next`: PASS, [workflow 38391276126](https://github.com/auersperg/flare/actions/runs/38391276126), source commit `f7baa56`. Registry `next = 0.3.7`, `latest = 0.3.1`. SHA-512 integrity и все 63 externally installed files совпали с exact accepted archive; portable Node SDK imports и compiled CLI help прошли.
- Personal published-CLI update 0.3.6 → 0.3.7: PASS. Четыре завершённых pre-update capsules; статус → dry-run → confirmed update. Оба проекта и все четыре среды сохранили schema/releases/documents/auth users/settings/file metadata и SHA-256 bytes. D1 catalogue, Access app/audience/policies, bindings/secrets, namespace и custom domains сохранены; workers.dev/preview URLs остаются выключены. Повторные dry-run/confirmed update — no-op, новые Worker versions не создаются. Fixed-scope audit Worker удалён, временные credentials стёрты.

Никаких новых сервисов, фоновых таймеров, замен namespace, удаления приложений или data rewind. Backup/restore, jobs, permissions и lifecycle safeguards сохранены.

## Реальная проверка интерфейса

- Владелец `adam@auer.wien` имеет доступ к опубликованной панели.
- Health: ready, правильный cloud URL и прежний application hash; Insights отсутствует, history первоначально закрыта.
- Раскрытие history показывает пять retained builds, active marker и прежние contract/promote/rollback actions; релиз приложения ради UI-проверки не переключался.
- Create project: нет поля workspace; name, optional alias и origins видны. Форма проверена без создания лишнего production-проекта. Default/invalid explicit customer проверены unit regressions.
- Production Data: две прежние строки, Add/Edit/Delete row присутствуют, Add/Edit table отсутствуют. Реальные данные ради проверки не редактировались.
- Schema: прежние поля, indexes и contract видны, draft-конструктора нет.
- Settings → Backups: список появляется после одного раскрытия; прежние copies и новая pre-update copy доступны, дополнительного Manage/Close toggle нет. Удаление/restore production copies не выполнялись.

## Что именно удалено

- `scripts/setup-cloud.mjs` — retired direct provisioner.
- `packages/core/admin.wrangler.example.json` и `runtime.wrangler.example.json` — второй ручной источник конфигурации.
- `packages/core/dashboard/src/components/table-guide.tsx` и `src/lib/table-schema.ts` — неиспользуемый теперь draft-конструктор.
- `docs/flare-architecture-map.md` — дублирующий индекс полной карты.

Это шесть удалённых файлов: 732 строки retired setup/config/UI исходников и 36 строк дублирующего doc index (по исходному git snapshot). Дополнительно сокращены существующие views. Исторические доказательства перенесены, а не потеряны. Общий gzip всех dashboard JS в exact archives: 180717 → 178208 bytes; это включает lazy chunks и **не** измерение initial download или latency.

Поддерживаемый `platform adopt` сохранён: это явная миграция стандартной установки в тот же managed generator/journal, не альтернативный direct deploy. Storage/wire identifiers старых приложений, private recovery files, старые опубликованные archives и backup copies также сохранены намеренно.

## Evidence и ограничения

Локальные ignored reports: `platform-037-cross-version-cloud-acceptance.json`, `platform-037-registry-acceptance.json`, `platform-037-personal-update-acceptance.json`, `platform-037-dashboard-size-comparison.json`. Source CI [38390833822](https://github.com/auersperg/flare/actions/runs/38390833822) PASS; protected release повторил gates. Screenshots: `personal-panel-037-updated.png`, `personal-panel-037-project-form.png`.

Предварительный candidate до финального UI review сохранён отдельно; final cloud acceptance и publication используют только digest `e7c746146383646d2a33266f89c3a43ea0b1eff9167edbd9ccbeeb0f5432a15c`. Однократный audit-helper GET получил 404 до backup POST; возобновлён существующий helper ограниченными read retries, без создания второго helper и без слепого повтора writes. Итоговый cleanup PASS.

SDK realtime/permissions/data isolation/jobs/backup fences не упрощались ценой гарантии. Dashboard по-прежнему snapshots без interval polling, не новый push channel. Independent account/full graceful drain/off-account DR остаются непроверенными; нагрузочная кампания 0.3.6 не повторялась и не выдаётся за новую 0.3.7 workload acceptance. Daily backup пока ручной; RPO 24 часа не обеспечивается одним backup перед обновлением.
