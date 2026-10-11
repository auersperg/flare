# Flared 0.3: архитектура, накладные расходы и проверка

Обновлено 11 октября 2026. Проверяется текущий ABI 4, а не прежний SDK 0.2. Статус — native-data preview; завершение отдельных тестов не является полной production-сертификацией.

## Основа

Два основных Worker: Admin с онлайн Astro/shadcn dashboard и Runtime. D1 хранит каталог, права и аудит, но отсутствует в пути запросов приложения. На project/environment — supervisor DO и постоянный facet `app` с собственной SQLite. Файлы — R2, задания — Queues, расписания и восстановление — native Lifecycle/Scheduler alarms. Bun нужен для разработки, CLI и сборки; облачный runtime остаётся Cloudflare Workers.

Один устанавливаемый пакет `flared`: SDK, React hooks и lazy CLI. В коде только `query`, `mutation`, `action`. Query одновременно доступна разовым HTTP-вызовом и подпиской; `useQuery`/`onUpdate` получают первый результат непосредственно через shared hibernating WebSocket, без дополнительного HTTP query или polling. `/v1/live` — транспорт, не четвёртый вид функции.

Документный SDK — небольшой адаптер над native SQLite: отдельные таблицы, JSON documents, expression indexes и SQL keyset pagination. Drizzle, отдельного SQL-сервера, Redis или собственного постоянно работающего backend нет. Мутация атомарно фиксирует данные, revision, outbox и валидированный результат. Удалять эти границы ради меньшего числа строк нельзя.

## Исправления A–F

| Область               | Реализовано                                                                                                                                                                                                                                                                                             | Граница                                                                                                                                                                         |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A. Диагностика чтения | Успешный разовый query попадает только в bounded memory ring на 100 entries, без SQL INSERT/DELETE. Mutation/action/errors сохраняют bounded durable history. Ошибка записи диагностического журнала не заменяет результат функции.                                                                     | Query history теряется при hibernation/restart. Logs — recent summaries, не полный Tail или billing. Ошибка чтения журнала показывается, а не превращается в «всё хорошо».      |
| B. Static assets      | Только `/_astro/*` идут asset-first: immutable public UI bundles, без app secrets. HTML, API, bootstrap и starter остаются worker-first с авторизацией и CSP.                                                                                                                                           | Access не отключён. Публичная статика не означает публичные административные данные.                                                                                            |
| C. Jobs               | Нативный `sendBatch`: до 100 сообщений, ограничение UTF-8 bytes. После подтверждения Queue — один transactional `markJobsSent` RPC на batch. Consumer обрабатывает до четырёх сообщений параллельно с отдельными ack/retry.                                                                             | Доставка at-least-once; неизвестный итог enqueue сохраняет recovery/outbox. Receipt не обеспечивает exactly-once внешнего эффекта. DLQ replay ещё не реализован.                |
| D. Retention и файлы  | Immutable builds теперь имеют prefix project/environment; GC 30 дней защищает active/candidate/outbox/jobs и удаляет только собственные blobs. D1 audit 90 дней, expired credentials с grace 14 дней, bounded on-traffic cleanup с durable lease. Files — keyset pages до 100 записей, dashboard по 50. | GC не просыпается по периодическому таймеру. Expired credentials — не активные права. Jobs/Logs остаются bounded recent history, не бесконечной лентой.                         |
| E. Admission/cache    | Один serial admission для функции; config и activation кешируются в isolate с явной invalidation на изменениях. После hibernation восстанавливаются из durable SQL. Action выполняется вне общей serial gate, сохраняя pinned release.                                                                  | Сериализация mutations/recovery/release не снята. Action callbacks не блокируются сами на себе.                                                                                 |
| F. Role compilation   | Обычный registry flow генерирует action-only entry из named exports, без schema/query/mutation-only modules. Unit proof проверяет отсутствие query handler в action bundle.                                                                                                                             | Facet сохраняет необходимые declarations/validators; полного dependency splitting всех facet handlers нет. Advanced custom entry не получает автоматическое registry splitting. |

Нативные границы: [Facets](https://developers.cloudflare.com/dynamic-workers/usage/durable-object-facets/), [SQLite storage](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/), [Queue API](https://developers.cloudflare.com/queues/configuration/javascript-apis/), [at-least-once](https://developers.cloudflare.com/queues/reference/delivery-guarantees/), [asset routing](https://developers.cloudflare.com/workers/static-assets/routing/worker-script/).

## Дополнительная экономия без потери корректности

- Broadcast без sockets завершается до facet snapshot RPC.
- Per-broadcast cache ограничен 4 MiB учитываемых encoded bytes и 64 entries; hash удерживаемого результата вычисляется один раз. Ключ включает полную identity; результаты разных пользователей не смешиваются. Это не точный лимит JS heap и не межрелизный stale cache.
- Anonymous WebSocket больше не имеет искусственного 15-минутного auth expiry/alarm. Настоящий JWT продолжает истекать, закрывать socket и очищать live-данные. Одноразовый handshake ticket живёт 60 секунд.
- Dashboard не опрашивает API по таймеру. Lazy views, ограниченные страницы и отмена запросов предотвращают ненужные чтения и stale UI.
- Нет keep-warm, собственного interval loop или отдельного GC-сервиса. Native alarm существует только для необходимой задачи, recovery, expiry или cleanup. Storage продолжает занимать ресурсы даже в idle.

## Проверенные результаты текущего патча

- `bun run verify`: **270 unit tests PASS**, TypeScript/Astro, форматирование, build/CSP/import boundaries и независимая установка одного tarball — PASS.
- `bun run test:kernel`: **42 отдельных native checks PASS** (16 kernel + 10 SDK + 16 Core). Проверены SQL rollback, live invalidation, persistent upgrade, native batch jobs, R2 grants/streaming, отсутствие idle alarm, реальные JWT deadlines и anonymous subscription без лишнего wake.
- Runtime, Admin, миграция D1 retention и test dev/prod обновлены в Cloudflare. Старые active blobs перенесены в scoped prefixes до обновления loader, без удаления app DB при смене кода.
- **16 short cloud checks PASS**: 1002 документа, keyset, CRUD/live, auth/origin, Queues, rollback, slow ACK, code upgrade и физическая hibernation с новым boot ID и сохранением socket.
- Test app: 9 CRUD/live/action проверок и R2 streaming/internal boundaries/outbox rollback/cancel/delay/retry/cron — PASS. Тестовый cron остановлен. Дополнительно 12 jobs из одной mutation/native Queue batch завершились с одной попытки каждый; proof rows удалены.
- Настоящая загрузка через dashboard завершилась `ready`; проверка использовала синтетический файл, а не пользовательские документы. Проверены все основные вкладки и Access на основном домене/workers.dev.
- **30.40 минут / 100 SDK live-клиентов — PASS**: 30 mutations, все 100 клиентов получают каждую committed revision, reconnect и обновление JWT, в том числе массовое обновление identity. 17 cloud checks (16 основных + soak). Delivery до последнего из 100 клиентов: median 482 ms, min 374 ms, max 3458 ms. Это aggregate client path с auth refresh/cold wakes, не p95 одной подписки, не comparable benchmark прежних 98 ms и не измерение billing. Отчёт: ignored artifacts/platform-68ffcc6f-0f7c-428d-81f1-256aaefdd1a8.json.

Число unit tests не доказывает физическую hibernation, стоимость или отсутствие всех security flaws. Облачные и локальные результаты разделены намеренно.

## Открытые product gates G–H

**G. Reactive semantics:** table-level dependencies, transactional snapshot и suppression неизменившихся результатов реализованы. Нет полного Convex index-range/read-set engine, clock/random virtualization и атомарного React rendering нескольких разных queries. Handler query должен быть чистой функцией DB/args/auth; timer для имитации этой гарантии не добавляется. [Convex query semantics](https://docs.convex.dev/functions/query-functions).

**H. Эксплуатация:** portable one-command platform installer для другого аккаунта, unrestricted export/PITR, dashboard Secrets Store provisioning, DLQ inspect/replay, полный graceful deploy drain/crash proof, внешняя OIDC приёмка, analytics datasets и delegated customer membership ещё не завершены. Operator installation в текущем аккаунте не является portable installer. Существующий CLI developer flow работает, публичный npm не публиковался.

## Стоимость: подтверждения и ограничения

Hibernation не начисляет DO duration во время сна, но active execution, messages, SQL, storage и cron events остаются учитываемыми. [WebSocket hibernation](https://developers.cloudflare.com/durable-objects/best-practices/websockets/).

Loader ID стабилен: scope + hash + ABI + policy digest + compatibility date + role. В нём нет user token/request ID. Daily-unique identity всё равно учитывается по дням, а не один раз навсегда. Пример, **не billing measurement**: 10 проектов × 2 ежедневно активные среды × 2 роли × 30 дней = 1200 creation units; при включённых 1000 это $0.40 overage по $0.002. Остальные ресурсы считаются отдельно. [Dynamic pricing](https://developers.cloudflare.com/dynamic-workers/pricing/).

Не обещаем ускорение p95 без сопоставимого измерения или полный месячный счёт $5. Load delivery samples включают клиентский путь и не являются CPU/GB-s. Cloudflare account usage и datasets должны быть измерены отдельно, а не выведены из числа functions в dashboard.

## Итоговое состояние установки

После завершения soak удалены четыре acceptance-проекта (восемь сред), их facet storage/files/scoped bundles, четыре устаревших shared build blobs и временные maintenance Workers. Каталог содержит только Local и test. Их IDs, aliases, Cloudflare Access, домены и активные CLI credentials сохранены. Local dev/prod обновлён пустым bootstrap; test dev/prod используют один свежий release. Удалены три старых тестовых файла и шесть app rows; dev заново наполнен тремя понятными задачами. Pending jobs и включённых cron после сервисной приёмки нет; internal receipts/audit сохраняют корректную bounded retention. Старый tarball 0.2 и лишний test archive удалены, legacy SQL review заменён текущей картой.

В локальном Astro устранён stale Vite SDK cache (HTTP 504), сервер перезапущен на 127.0.0.1:4321. Настоящий browser flow: live snapshot и пять проверок playground — PASS. Смена runtime/данных не оправдывает отключение browser/Access security; этого не делалось.

### Ресурсы контрольного окна

Cloudflare GraphQL snapshot за **13:30–14:02:50 UTC** включает soak, подготовительные проверки, UI и cleanup, а не только один benchmark. Sampled Admin/Runtime: **1964 requests, 2143 ms CPU**, поле execution errors — 0. Supervisor namespace: **6.34 GB-s duration**, 7.98 s CPU, 83 875 rows read и 17 337 rows written. Превышений CPU/memory и fatal internal errors в periodic dataset — 0. Invocation dataset отдельно содержит шесть `clientDisconnected` outcomes (пять HTTP, один alarm); они не скрыты и не объявлены шестью авариями приложения. Полный контекст этих отмен отдельно не восстановлен.

Это snapshot адаптивной аналитики с возможной задержкой, не точный bill, не сумма всех Dynamic/facet creations/startup/R2/Queues/Logs и не прогноз месяца. Нельзя подменять duration суммой открытого времени 100 sockets. Raw scoped aggregates без токенов — ignored `artifacts/soak-resource-usage.json`. Методика: [Workers analytics](https://developers.cloudflare.com/analytics/graphql-api/tutorials/querying-workers-metrics/), [DO analytics](https://developers.cloudflare.com/durable-objects/observability/metrics-and-analytics/).

## Следующий этап: backup/restore — завершён в ограниченном scope

270 unit tests и 42 native checks PASS. Добавлены on-demand Settings → Backups и один CLI `backup` с create/list/restore/delete/status. Private R2 использует существующий bucket; ничего не запускается по таймеру. Snapshot сохраняет native IDs/timestamps/revision, ready files и exact code hash. Secrets/OIDC/origins/cron/job history не копируются. Restore — только в другую пустую среду того же проекта; это не promote и не in-place database rollback.

Пять real-cloud checks PASS: 111 документов с keyset pagination, file bytes и hash, auth/scope/confirmation, refusal непустой цели, corrupt-file fence и source pin, repair/explicit retry/idempotence. Workerd дополнительно проверил forced supervisor abort с сохранением fence. Результат: ignored artifacts/backup-cloud-acceptance.json; временный проект/Worker и его ресурсы удалены. Admin/Runtime, Local/test backend releases и test tarball обновлены без удаления существующих app rows. Девять test CRUD/live/action checks PASS.

Bounds: 10k документов / 4 MiB logical data, 100 файлов / 100 MiB. Backup удерживает serial gate и требует паузы cron/drain jobs/actions/uploads. Сохранённые и partial copies занимают R2 до явного удаления. Полноценное восстановление occupied prod/new project, внешняя DR/PITR, exact-hash promote, OIDC/DLQ и остальные H gates остаются открытыми; название backup не является production-сертификацией.
