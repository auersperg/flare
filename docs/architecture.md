# Flared — единая архитектура Cloudflare-native платформы

Обновлено: 11 октября 2026 года. **Статус: 0.3 native-data preview; базовый облачный flow проверен, полная production-приёмка не завершена.**

Этот документ заменяет прежнее предложение Reactive с обычным Worker на проект. Канонические ограничения: `flared.product.json`. Фактические результаты и незакрытые проверки: `README.md`. Старый SDK 0.1 удалён из рабочего репозитория.

## 1. Продукт и разделение проектов

**Flared устанавливается в собственный Cloudflare аккаунт оператора. Dashboard существует только онлайн в Cloudflare. Локально — frontend приложения, SDK и тонкий CLI.**

Иерархия: установка → пространство заказчика → проект → окружение `dev` / `prod`. Заказчик здесь — владелец магазина, лендинга или другого проекта; SDK-клиент — код приложения, подключённый к конкретной среде. Одно пространство может содержать несколько проектов.

Каждое project/environment имеет собственные SQLite-данные, выпуск, настройки авторизации, файловый namespace, задания и подписки. Идентичность хранилища основана на неизменяемых IDs, не на названиях. Права и принадлежность заказчику проверяются сервером: вкладки dashboard не обеспечивают изоляцию.

Две среды не требуют двух установок платформы. Локальный frontend подключается к cloud dev; production — отдельная облачная среда с явно подтверждаемой публикацией.

## 2. Только онлайн-dashboard

- Один web-интерфейс: Cloudflare Static Assets + Admin Worker, защищённый Cloudflare Access.
- Нет локального dashboard, локального административного сервера или второй UI сборки для CLI.
- CLI не обслуживает панель через localhost. Возможная команда открытия панели только откроет её облачный URL.
- Панель, CLI и CI используют общий API управления. Owner/editor/viewer, scope и аудит проверяются сервером. Сейчас Access допускает только владельца; роли команды общие для установки, отдельное делегирование заказчикам ещё не реализовано.
- Приложения работают через Runtime Worker: закрытие или недоступность dashboard не останавливает данные, подписки и задания.
- Логи, метрики и recovery работают независимо от открытой панели. Обновляется только видимый раздел, данные читаются постранично, скрытые вкладки не создают лишний опрос.
- Административные вкладки пока используют snapshots: обновление после собственных изменений и при возврате/focus, без interval polling. Неизменившаяся таблица остаётся видимой при фоновой загрузке. Cross-client изменения через SDK не доставляются в Data/Auth/Files автоматически в открытой панели; отдельный Access-authorized push/invalidation channel остаётся незавершённым. Компактная reload-кнопка для snapshots не является live-подпиской.

Работающий интерфейс: Health, Data, Schema, Functions, Files, Schedules, Auth, Logs; выбор проекта/среды в шапке, Settings под шестерёнкой, SDK под Health. Files и Schedules работают с настоящими R2/Queues/Scheduler; Secrets и полные analytics не имитируются. Новые проекты после установки обновлённого Admin получают пустой bootstrap, без демонстрационных таблиц/функций; существующие релизы и данные не сбрасываются. Data edits проходят mutation/commit/live и аудит; разрушительные prod-операции требуют подтверждения. Схема и функции меняются через код и релизы; native facet валидирует документы и применяет индексы транзакционно. Произвольный SQL, создание/drop таблиц мышкой и компиляция в браузере не входят в MVP.

## 3. Облачные компоненты

| Компонент                            | Назначение                                                                       |
| ------------------------------------ | -------------------------------------------------------------------------------- |
| Admin Worker + Static Assets         | Онлайн-dashboard, роли, каталог и релизы                                         |
| Runtime Worker                       | API приложений, loader, actions, Queues consumer                                 |
| D1                                   | Каталог заказчиков/проектов/сред/релизов и аудит; не app DB                      |
| Supervisor DO на project/environment | Активный релиз, физические WebSockets, auth-aware подписки, расписания, recovery |
| Постоянный facet `app`               | Изолированная native SQLite, документы/индексы, query/mutation                   |
| Dynamic Worker action-role           | Actions без прямого доступа к app SQLite                                         |
| R2                                   | Неизменяемые сборки, файлы, экспорты                                             |
| Queues + Scheduler                   | Outbox, отложенные задания, повторная доставка и DLQ                             |
| Tail / Workers Logs / Analytics      | Ошибки и метрики; доступность datasets проверяется                               |
| Secrets Store                        | Scoped native bindings; dashboard provisioning ещё не реализован                 |

Два основных Worker общие для проектов, **не два Worker на каждого заказчика**. Frontend сайтов размещается независимо; статическому лендингу не обязательно использовать backend SDK.

Основа — Dynamic Workers + native Durable Object Facets. Beta/экспериментальные API фиксируются по версиям и проверяются в настоящем Cloudflare. Нет скрытого fallback к обычным Worker на проект. Supervisor использует публичные Lifecycle/WebSockets/Scheduler, не полный Agent, AI/MCP или приватные SDK методы. WebSocket/alarm принадлежат supervisor; между ним и facet — сериализуемый native RPC.

## 4. Выполнение, релизы и безопасность

- Сборка происходит в CLI/CI. R2 содержит код, manifest, document schema и SHA-256.
- Loader ID стабилен для project/environment + build hash + config version + compatibility date + runtime role; request ID и access token в него не входят.
- D1/dashboard не находятся в пути каждого вызова приложения. Активное состояние среды хранится в supervisor.
- Имя facet остаётся `app`. Обновление через `abort()`, не удаление данных. Prepare/drain/migrate/activate и recovery требуют долговечного журнала. Rollback кода не является rollback базы.
- Queries read-only; mutation фиксирует данные, revision, validated output и outbox транзакционно. Live отправляется после commit. Внешние эффекты — в action.
- Read capability предоставляет только `get/query`; raw SQL, storage и write methods не выдаются. Capability отзывается после вызова; mutation использует native transaction.
- Перед mutation supervisor долговечно планирует recovery. Generic SDK outbox связан с native Queues consumer/recovery и проверен фактической delivery receipt.
- Queues — at-least-once: deduplication, retry/DLQ и идемпотентность внешних эффектов обязательны. Старые сборки сохраняются, пока на них ссылаются задания.
- Data-role не имеет egress; actions получают scoped capabilities; native outbound gateway запрещает сеть по умолчанию и разрешает только адреса operator policy. Реальная облачная приёмка gateway ещё не проведена. Общие D1/R2 bindings и account token не передаются приложениям.
- API приложений: HTTP JSON; live: hibernating WebSocket, короткоживущий single-use ticket, ACK/coalescing/reconnect snapshot. JWT/OIDC signature/issuer/audience/JWKS/expiry и origin allowlist обязательны для production.
- Авторизация администратора отделена от авторизации пользователей приложений. Deploy credentials не попадают в frontend env: публичным является URL среды, не административный токен.
- Первый MVP предназначен для доверенных разработчиков оператора, не для публичного исполнения чужого непроверенного кода.

## 5. Пакеты и тонкий локальный flow

| Пакет                       | Граница                                                                                   |
| --------------------------- | ----------------------------------------------------------------------------------------- |
| `flared`                    | Один SDK + CLI: `src/sdk` и `src/cli`, отдельные browser/server/React/native entry points |
| `@flared/platform` (`core`) | Облачный runtime и онлайн-dashboard; не dependency приложения                             |

Исполняемый файл — `flared`. Это локальные tarballs, не опубликованные пакеты. Scope не означает подтверждённого владения npm namespace. License пока UNLICENSED; open source требует явно выбранной лицензии и независимой установки в другом аккаунте.

**Основной реализованный flow:**

```sh
# Сейчас — проверенный приватный tarball, не опубликованный npm пакет
bun add /path/to/flared-0.3.1.tgz
bunx flared dev
# Browser approval → выбор/создание проекта → cloud dev + typed API
# Frontend запускается своим обычным dev server
bunx flared deploy
# Сборка и prod-публикация с явным подтверждением проекта
```

Единый пользовательский пакет `flared` содержит portable SDK и lazy Bun CLI. В исходниках Core/SDK/CLI остаются внутренними границами, не отдельными обязательными установками пользователя. Схему задают в `flared/schema.ts`, функции — в `flared/*.ts`. CLI генерирует `_generated/server.ts`, `_generated/api.ts`, facet/action bundles, schema/manifest/checksums и OpenAPI 3.1. Браузер не импортирует backend-код.

Advanced pipeline: `flared build --entry app.ts --outdir release`, `flared link --platform <runtime-url>/control --project <UUID>`, `flared dev --entry app.ts`, `flared deploy --env dev --release release`. General `platform init` остаётся незавершённым operator workflow; `db generate` не нужен и удалён. Локального dashboard нет. Local workerd в acceptance scripts — внутренний тест ядра, не зависимость установленного CLI и не основной developer flow. Сборка или тесты ничего не публикуют в облако.

Авторизация dashboard использует нативный `ctx.access`, проверяет AUD конкретного Access приложения и получает platform-verified identity. JWT/OIDC приложений — отдельная граница. Новая установка имеет два Worker `flared-admin`/`flared-runtime`; не используются ресурсы старого kernel. Панель не делает background polling; static assets сейчас проходят Admin Worker для access/headers, поэтому такие посещения учитываются в Worker requests.

## 6. Совместимость и оставшаяся приёмка

Legacy SDK/CLI и обе демонстрации убраны из рабочего репозитория; восстановимые копии находятся вне него. В production build входит только пустой bootstrap. Минимальные тестовые приложения остаются в tests и не используются как production seed. В 0.3 legacy ABI 1–3 и SQL/Drizzle API удалены, системный prefix нового facet — `_flared_`. Установка/среда для новой версии должна быть чистой: совместимости с прежними хранилищами не обещаем. Локальная сборка не удаляет существующие облачные ресурсы или данные.

Локальный kernel имеет тестовую конфигурацию без account ID; конфигурация существующей облачной приёмки хранится отдельно и не коммитится. В Git входят только шаблоны Admin/Runtime, а рабочие конфигурации остаются у оператора. Перед open source нужны независимая установка, лицензия и подтверждение registry scope.

Обязательны: расследование зарегистрированного WebSocket timeout, повторные hibernation/recovery проверки, независимый production OIDC provider, полное draining/crash recovery релизов, provisioning и облачная проверка Secrets Store/egress, расширенная crash/load-проверка файлов/cron, реальные dashboard datasets, clean install → два проекта → dev/prod → frontend → upgrade, экспорт/restore и нагрузка 1 000 записей / 100 live клиентов / 30 минут. Latency/cost нового runtime не выводятся из коротких kernel проверок.

Цены и лимиты сверяются с фактическим workload и актуальной документацией, не фиксируются как вечное обещание $5 за весь сервис. Основные ссылки: [Dynamic Workers / Facets](https://developers.cloudflare.com/dynamic-workers/usage/durable-object-facets/), [Static Assets](https://developers.cloudflare.com/workers/static-assets/billing-and-limitations/), [Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/).

## 7. Files и Schedules — реализованный минимум (11 октября 2026)

- **Файлы:** приватный R2 binding `FILES`, отдельный bucket `flared-files`; Runtime также получает `DASHBOARD_URL` для точного origin онлайн-панели при файловых upload grants (не для API функций). Bytes не хранятся в SQLite. Supervisor хранит метаданные и временные bearer grants, привязанные к неизменяемому project/environment. Прямые публичные R2 URL не выдаются.
- `ctx.files.generateUploadUrl({name,type,size})`, `getDownloadUrl(id)`, `list({cursor,limit})` → `{page,isDone,continueCursor}`, `delete(id)`. Upload grant одноразовый; download grant допускает повторное чтение до истечения пяти минут. Получение grant авторизует приложение через свою action; скачивание по grant не требует повторного JWT. Ссылка является секретной capability — не логировать и не передавать посторонним.
- Серверные actions могут `upload(byteStream,type,{name,size})` и `download(id)`: native RPC streams → Runtime → R2. Размер известен заранее, максимум 10 MiB, `FixedLengthStream` проверяет точное число байтов без полного буфера. MVP MIME allowlist: plain text, PNG/JPEG/WebP, PDF, binary. Browser `fileMetadata()` сохраняет эти MIME; остальные форматы отправляет как binary с исходным именем. `uploadFile()` передаёт Blob без полного буфера, не отправляет cookies и не повторяет одноразовый grant. Таймаут/обрыв явно обозначаются как неоднозначный результат. Это не антивирус и не доказательство соответствия содержимого MIME. Download — attachment, nosniff, no-store. `Content-Length` проверяется, если передан; без него точный размер всё равно проверяет нативный stream. После успешного R2 commit неоднозначная ошибка подтверждения метаданных не удаляет объект: durable cleanup восстанавливает ready; повторный complete идемпотентен.
- Предел среды: 1 000 файлов, 2 000 активных grants; список показывает последние 100. Pending/deleting загрузки имеют долговечный cleanup job. После interrupted upload готовый объект правильного размера восстанавливается, незавершённые удаляются. R2 и SQLite не являются одной транзакцией; recovery закрывает обычные окна сбоя, расширенная crash-приёмка остаётся обязательной.
- **Одноразовые jobs:** mutation вызывает `ctx.jobs.schedule(path,args,{delaySeconds})`; запись outbox фиксируется в одной SQLite-транзакции с данными. Supervisor пробуждается нативным alarm через Lifecycle, передаёт due job в Queues, выполняется action закреплённого релиза. Action меняет данные через `runMutation`. Cron не заменяет очередь.
- **Cron:** action вызывает `ctx.schedules.set({name,path,cron,args})`, `cancel(name)` или `list()`. Пять cron-полей, UTC, минимум минута, максимум 20 имён на среду. Scheduler владеет расписанием через Lifecycle; его callback формирует outbox → Queues. Новая конфигурация имеет собственный generation ID; reconcile отменяет orphan/старые расписания. Пауза не отменяет уже переданное в очередь задание. Точное время старта и отсутствие пропусков при длительном outage не обещаются; backlog catch-up не реализован.
- `auth: "internal"` закрывает query/mutation/action для публичного HTTP/WS даже при подделанном JSON `internal:true`; вызвать их можно только scoped native capability/заданием. Для jobs рекомендуется internal action, без сохранённой пользовательской авторизации; требуемые user IDs передавайте валидируемыми args. Старый режим scheduled authenticated actions сохранён, но JWT может истечь до выполнения. Cron не принимает action с `auth:"required"`.
- Queues **at-least-once**, текущий consumer: 3 retries + DLQ. Успешные receipts подавляют повторную доставку, но crash между внешним эффектом и receipt допускает повтор; внешняя идемпотентность обязательна. UI показывает queued/running/failed/completed и число попыток; failed не равнозначно окончательному DLQ. Pending outbox jobs можно отменить через mutation `ctx.jobs.cancel(id)` или dashboard; уже enqueued/running action отмена не останавливает. Replay и UI инспекции DLQ ещё не реализованы. Acked outbox удаляется; receipts/completed-or-failed summaries сохраняются 30 дней с bounded on-traffic cleanup. Release metadata защищает active/candidate/outbox/job references; R2 builds имеют scoped project/environment prefixes и удаляются вместе со старой metadata после проверки active/candidate/outbox/job references.
- Dashboard Files: загрузка, метаданные, скачивание, удаление; изменения защищены owner/editor и prod confirmation, с аудитом. Schedules: delayed jobs, реальные delivery events, cron список/пауза. Cron создаётся через код action, не SQL-редактор или постоянный frontend timer. Новое R2 binding требуется в конфигурации core; это не Worker на проект.

**Текущая приёмка 0.3:** 6 SQLite/FileStore/origin regression tests; текущий cloud dev — R2 streaming roundtrip и одноразовый grant, изоляция dev/prod, отзыв ссылки после удаления, Dynamic Worker RPC stream upload/download, закрытые internal функции, rollback данных вместе с outbox, задержка 5 секунд, retry после намеренной ошибки и реальный минутный cron с последующей паузой. Эти сервисные проверки не являются полной нагрузочной/production-приёмкой.

### Application distribution

`flared` is the only application-facing archive: portable SDK/type files and a separate lazy Bun CLI compiled directly from its own SDK/CLI source modules. There are no internal SDK/CLI registry dependencies. Client/server/React/native entry points remain isolated; React is optional. See [packaging](packaging.md).

## 8. Native document API 0.3 — breaking rewrite

`defineSchema({tasks:defineTable(z.object({...})).index("by_done",["done"])})` — один декларативный контракт для typed SDK, CLI, базы и dashboard. Typed declarations генерируются в `flared/_generated/server.ts` **до** сборки. Приложение использует `db.get/query/insert/patch/replace/delete`, а не SQL/ORM builders.

Каждая logical table — отдельная native SQLite table с `_id` UUID, `_creationTime` и `_data` JSON. Это сознательный выбор для Convex-like document DX: вложенные значения и optional/defaulted поля без DDL на каждое поле. Поля индексов превращаются в native SQLite expression indexes (`json_extract`), equality/range/order/keyset выполняются в SQL. Не общая tenant JSON-таблица, не фильтрация всей базы в JavaScript и не полный Convex read-set engine. Цена JSON serialization и expression indexes требует замера; ускорение в миллисекундах пока не обещаем.

- Закрытый object validator; до 100 таблиц, 64 полей, 20 индексов на таблицу, 1–4 scalar поля в индексе. Native SQL names не имеют case-insensitive коллизий.
- До 64 KiB на document; максимум 100 records/page, 256 KiB результата data query, 8 KiB continuation cursor. Огромные indexed string keys могут превысить cursor budget; используйте компактные ключи/индексы. До 1000 database operations и 100 scheduled jobs на invocation.
- Ввод/вывод функций — Standard Schema/JSON Schema; table validation общая для app CRUD и admin edits. Reads декодируют уже проверенные записи, без повторной table validation каждой строки; function output validation сохраняется.
- Queries получают revocable read capability **без** raw SQL, write/session/storage. Mutation capability отзывается после завершения. Неожиданные unawaited writes/jobs должны завершиться и не могут обойти transaction.
- Schema activation проверяет существующие документы; defaults нормализуются атомарно. Невалидные записи или удаление nonempty table отклоняют кандидата. Arbitrary SQL, скрытого destructively-reset и SQL journals нет. Изменение данных делается явной mutation.
- Изменённые таблицы и их последние revisions фиксируются с данными. Supervisor сохраняет read dependencies subscriptions; unrelated writes не пересчитывают live. Изменение release вызывает повторную проверку независимо от данных. Recovery использует долговечную revision map, поэтому crash не теряет invalidation.
- `ctx.jobs.cancel(id)` / dashboard Cancel удаляет только waiting outbox job; уже отправленную в Queue или выполняющуюся action не отменяет. Cancel внутри mutation транзакционен, job references проверяются за всеми pending pages.
- После подтверждённого Queue enqueue outbox row удаляется; duplicate delivery проверяет receipt. Receipts и completed/failed job summaries имеют 30-day retention и bounded cleanup на входящем трафике, без periodic wake. Это окно дедупликации, не exactly-once внешнего эффекта.
- Когда recovery завершён без due jobs, native Lifecycle job отменяется. Закрытие последнего socket отменяет auth-expiry wake. Cron/отложенное задание сохраняют только необходимые будущие alarms. Нет keep-warm, interval или фоново работающего сервера.
- Dynamic roles имеют native limits `cpuMs:1000`, facet `subRequests:0`, action `subRequests:100`. Это ограничения отдельных вызовов, не глобальный потолок счёта. Tail пропускает пустые успешные события и ограничивает payload.

## 9. Опциональные capabilities actions

По умолчанию external egress и app secrets запрещены. Оператор добавляет `APP_CAPABILITIES` в Runtime vars, с mapping **immutable UUID/environment**, не short alias:

```json
{
  "PROJECT_UUID/dev": {
    "outbound": ["api.example.com"],
    "secrets": { "PAYMENT_KEY": "APP_SECRET_PAYMENTS_DEV" }
  }
}
```

В Wrangler `vars.APP_CAPABILITIES` — JSON-строка. `APP_SECRET_PAYMENTS_DEV` — настоящий `secrets_store_secrets` binding с `store_id` и `secret_name`, не пароль в vars. `ctx.secrets.get("PAYMENT_KEY")` читает только этот mapping через native binding `.get()`; core signing key и общие R2/D1 bindings невозможно выбрать этим API. Dashboard write-only provisioning ещё не реализован; изменение bindings требует core deploy. [Secrets Store integration](https://developers.cloudflare.com/secrets-store/integrations/workers/).

Action `fetch()` проходит native `globalOutbound` gateway: exact reviewed public HTTPS host, без IP/localhost/wildcards/не-default ports/userinfo; TCP capability отсутствует. Redirect не следует автоматически; приложение делает отдельный разрешённый запрос. Запрос/ответ streaming bounded 1 MiB, deadline 10 s, platform headers убираются. Это trusted-team minimum, не универсальный SSRF sandbox для чужого кода; allowlisted DNS/endpoints должен проверять оператор. Query/mutation egress остаётся `null`. Stable loader key включает ABI/release/scope/compatibility date и digest non-secret policy, без request/user tokens. [Native egress](https://developers.cloudflare.com/dynamic-workers/usage/egress-control/), [native limits](https://developers.cloudflare.com/dynamic-workers/usage/limits/).

JWKS используют bounded cache, single-flight refresh, импортированные Web Crypto keys. Unknown kid допускает refresh с минутным cooldown; нормальный срок cache — пять минут. Native Access и app OIDC остаются разными auth boundaries.

## 10. Результаты и оставшиеся границы

Актуальный список исправлений A–F, проверок и открытых product gates — [архитектурный аудит 0.3](architecture-audit-0.3.md). Не дублируем исторические hashes и counts как результаты текущего runtime.

Текущий патч проверен 276 unit tests, 43 native checks и 16 короткими cloud checks; обновлены Admin/Runtime и test dev/prod. Проверены R2 streaming, Queues, rollback, реактивность, physical hibernation и загрузка через настоящий dashboard. 30.40-минутный cloud soak со 100 клиентами прошёл; точная стоимость и comparable latency baseline измеряются отдельно.

Публичная hashed UI статика asset-first; HTML/API/bootstrap защищены. Успешные queries не пишут SQL diagnostic history. Scoped R2 GC и catalog retention работают ограниченными пакетами на трафике, без постоянного timer. Native `sendBatch` и bounded consumer используют Queue retries/DLQ, а не собственный job server. `files.list({cursor,limit})` возвращает `{page,isDone,continueCursor}`; dashboard показывает по 50 файлов.

Native RPC добавляет transport handles к object results. SDK потребляет JSON capability response через native `structuredClone` и освобождает handle; Streams/Response не проходят JSON adapter. Это проверено nested action→query regression. [RPC lifecycle](https://developers.cloudflare.com/workers/runtime-apis/rpc/lifecycle/).

Only query/mutation/action exist. React `useQuery` и JS `onUpdate` используют первый WS snapshot без дополнительного HTTP query; HTTP `query` остаётся явным одноразовым чтением. Это Convex-like DX, не полный клон его read-set engine или atomic cross-query rendering.

Ограниченный логический backup/restore проверен (см. maintenance); unrestricted export/PITR, portable installer, dashboard secrets provisioning, DLQ replay, graceful release drain/crash proof, внешний OIDC и account-wide cost measurement остаются открытыми. Данные временной приёмки очищаются только после её завершения; Local/test IDs и настройки доступа сохраняются.

## 11. Ограниченные backup/restore

Private R2 capsule: exact backend release + native document snapshot + ready file bytes. Manifest SHA-256 и file MD5 проверяются при восстановлении; manifest публикуется последним. Никаких новых сервисов или periodic backup alarms. Supervisor gate удерживается на bounded maintenance window. Restore допускается только в другую пустую среду того же проекта, сохраняет access configuration и не переносит secrets/jobs/cron. Durable fence блокирует вызовы после сбоя, source pin блокирует удаление backup до завершения. Явный retry того же ID, без автоматического повторения writes.

Пять real-cloud backup checks PASS (111 документов, файл, exact release, corrupt-file fencing/retry); workerd forced-abort proof PASS. Это не promote и не rollback существующей базы. Лимиты, стоимость хранения и непроверенные disaster-recovery варианты — [maintenance](maintenance.md#on-demand-logical-backup-and-empty-target-recovery).

## Immutable release flow

Supervisor хранит пять последних уникальных успешных backend-сборок и дату первой публикации. Активация и запись успешной истории фиксируются в одной supervisor SQL-транзакции; это не распределённая транзакция с facet или frontend. Неуспешные candidates не входят в историю. Retention защищает последние пять, active/candidate и ссылки jobs/outbox, без периодического timer.

Promote переносит точный проверенный dev bundle в prod без повторной компиляции и без данных dev. Expected-active-hash защищает от конкурентного изменения prod. Rollback проверяет совместимость кода со схемой текущих документов и заданиями, но не откатывает данные. Health сразу показывает последние пять успешных релизов выбранной среды: Development releases или Production releases, без дополнительной кнопки и без interval polling.

CLI `--cmd` собирает frontend до активации backend, передавая URL выбранной среды только дочернему процессу. Отдельный native Wrangler публикует frontend после backend; ошибки последнего шага явно означают partial release. Исторические изолированные preview и связанный каталог версий frontend/backend пока не реализованы. Проверка облачной истории/promotion/rollback входит в шестой disposable backup/release acceptance check.

## Built-in password authentication

Optional native supervisor SQLite stores users, salted password hashes, bounded sessions and on-traffic login counters, separately from the app facet. No auth/ORM dependency or additional Worker/DO binding. Native node:crypto scrypt N=16384/r=8/p=5 (16 MiB principal memory, bounded maxmem) matches an OWASP scrypt profile; the deployed Cloudflare proof exercises hashing, not just Bun. Random salts are 128-bit; opaque session tokens are 256-bit and only their SHA-256 identifiers are stored. Sessions last up to 12 hours, max five/user; no automatic refresh or always-on timer. Session verification uses native local SQL, not D1 or a third-party identity request.

Auth defaults disabled for an environment. Owner enables Auth and public registration independently; registration never grants platform roles. Public POST /v1/auth/register, login, logout, me and change-password are origin-checked. Open registration/login have a global environment budget of 30/minute and five/minute per normalized login, in addition to the public edge limiter. Limits persist across restarts. Failed/unknown/blocked login responses do not expose user details. Passwords require 6–128 characters by operator choice; six-character passwords are weak for public accounts, and longer unique passphrases are recommended. Passwords/hashes are never returned by public or dashboard APIs and cannot be inspected through application db.

Auth tab paginates 50 users, refreshes on demand, and permits owner-only create/reset/block/revoke/configuration with production confirmation, Access/CSRF checks and audit. Project-scoped CLI credentials cannot modify end-user authentication. Password changes revoke every session; explicit logout revokes its own session. Revoked socket identities are closed and also rechecked before delivery/calls; queries/actions receive the same ctx.auth. App functions still implement record/organization permissions; authentication is not automatic row-level security. External identities should be keyed by issuer+subject, not unverified client user IDs.

createPasswordAuth persists only the opaque session token and expiry in browser localStorage, namespaced by the complete project/environment URL. Call restore() before protected UI: it verifies /auth/me on the server before exposing a token or user. Connect onChange to client.refreshAuth; getUser() returns the already verified user without an extra request. Expired/revoked sessions are cleared; a network failure preserves storage for retry. Logout clears local state even when offline; browser storage events synchronize other tabs. No passwords, always-on polling, automatic write retries or credentials in URLs. Browser persistence remains JavaScript-readable, as with the Convex Auth browser pattern: prevent XSS and avoid untrusted scripts. This is a bounded 12-hour session, not an indefinite refresh-token flow. Server JS defaults to memory-only, and storage can be null or a custom synchronous adapter. Dispose removes listeners without revoking or deleting a durable session. No backend migration or additional KV/DO is required.

Private logical backups now preserve user IDs/login/password hashes/blocked status but never active sessions. Only an empty target (including no users) can be restored. Authentication enablement/registration settings stay with the target and are not promoted or restored implicitly. Old capsules lacking accounts restore no users. Credential backups are sensitive private R2 objects, not downloadable through dashboard. No email verification, emailed recovery, MFA, refresh-token flow or automated abuse challenge is claimed. Owners can reset passwords; anonymous recovery is unavailable. Public synthetic demo data remains public even after adding login.
