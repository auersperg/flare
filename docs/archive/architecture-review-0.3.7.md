# Архитектурный разбор Flare 0.3.7

Дата: 13 октября 2026. Исходники: `6576dc1`. Это снимок анализа, **не новый operating guide и не выполненный план исправлений**.

## 1. Вывод

Для личных и небольших trusted-team приложений основа разумная и достаточно минималистичная. Переписывать её целиком, объединять все компоненты в один Worker или удалять механизмы сохранности данных не нужно.

Оставшиеся проблемы — преимущественно незавершённый operator flow и поддерживаемость, а не лишняя инфраструктура. Основные следующие изменения:

1. Довести существующие outbound/secrets capabilities до управляемой конфигурации либо явно обозначить их недоступность в стандартной установке.
2. Сделать Access drift-проверку семантической и предусмотреть явное принятие разрешённых операторских изменений.
3. Сделать свежесть последней завершённой резервной копии достоверно видимой; не путать ручной backup с автоматическим выполнением RPO.
4. Разделить installation checkpoint и живую доступность в `platform status`.
5. Если нужна панель с актуальными изменениями других клиентов — добавить узкую push-инвалидацию, а не полный второй realtime engine.

Это рекомендации. Код, облако, данные, npm tags и личная панель в этом проходе не изменялись.

## 2. Что проверено и чего этот анализ не доказывает

- Сопоставлены три текущих руководства, исходники ключевых слоёв, managed configuration generator, lifecycle state, dashboard resources и acceptance/CI.
- Проведён целевой статический разбор архитектурных решений; это не утверждение о построчном exhaustive security scan всего репозитория.
- Повторно выполнен `bun test ./tests`: **398 pass, 0 fail**, 26 файлов.
- Повторно выполнен `bun audit --production --audit-level=high`: **не найдены известные уязвимости**, проверено 477 пакетов. Это не доказательство отсутствия уязвимостей в собственном коде.
- `bun outdated` показал кандидатов на toolchain updates; установка обновлений не выполнялась.
- Локальным вызовом настоящего `configurationDigest` подтверждено: изменение только `updated_at` меняет Access snapshot hash.
- Нативная модель сверена с текущими первичными документами Cloudflare.
- Облачные acceptance, нагрузка, recovery и UI в этом проходе заново не запускались. Исторические доказательства 0.3.7 остаются в [отчёте упрощения](./simplification-0.3.7-report.md); не следует выдавать их за новые проверки.

## 3. Карта решений: по каждому основному слою

| Слой / решение                                              | Оценка                                                                 | Что делать                                                                                                                                                                       |
| ----------------------------------------------------------- | ---------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Один публичный пакет SDK + CLI + platform payload           | Оставить                                                               | Один install/version для пользователя удобнее нескольких синхронизируемых пакетов. Core не должен попадать в frontend bundle; существующие packaging gates сохранить.            |
| Два общих Worker: Admin и Runtime                           | Оставить                                                               | Разделение control/data plane оправдано. D1 и dashboard не должны участвовать в каждом app query. Landing — отдельная статическая страница, не backend service.                  |
| D1 для каталога и memberships                               | Оставить                                                               | Это небольшой control-plane каталог, не вторая копия app database. Перенос каталога в app DO ради уменьшения числа продуктов ухудшит discovery и административные операции.      |
| Supervisor + persistent AppFacet + отдельная SQLite         | Оставить                                                               | Это нативная модель Dynamic Workers, а не самодельный контейнерный слой. Один scope на project/environment — достаточно для текущего размера приложений.                         |
| Отдельные Actions со scoped capability                      | Оставить; закрыть configuration gap                                    | Actions не получают весь namespace, storage или account token. Нужен простой поддерживаемый способ разрешать конкретные внешние API и secret bindings.                           |
| Document API, schema в коде, индексы и keyset pagination    | Оставить                                                               | Не добавлять ORM, UI-конструктор схемы или второй migration framework. Для app evolution нужны совместимые изменения и явные app migrations при необходимости.                   |
| Native RPC и command/dispatch adapters                      | Оставить; улучшать типы локально                                       | Явные adapters/error envelopes поддерживают последовательное обновление Admin/Runtime. Уменьшать вложенные `any` по операциям, не создавать универсальную RPC/codegen платформу. |
| Две serial gates: Supervisor и Facet                        | Оставить                                                               | Разные владельцы состояния и await-boundaries. «DO однопоточный» не заменяет управление асинхронной последовательностью. Удаление gates без доказательства опасно.               |
| Live queries: hibernating sockets, table-level invalidation | Оставить                                                               | Для небольших приложений это проще read-set engine и распределённого cache. Более точные зависимости нужны только после измеренного лишнего fan-out.                             |
| Dashboard snapshots                                         | Честно обозначить; push — при необходимости                            | Нет interval polling, но нет полной cross-client актуализации Data/Auth/Files. Перезагрузка при focus/собственном изменении не равна realtime.                                   |
| Access admin / project CLI credentials / app auth           | Оставить                                                               | Три разных назначения и scope. Не объединять их одним «удобным» account token и не вводить ещё один identity server.                                                             |
| Password auth                                               | Оставить для текущего scope; оценить политику перед публичным запуском | Минимум сейчас 6 символов. Public consumer auth требует отдельного решения о password policy и recovery. Не добавлять MFA/email recovery автоматически «на будущее».             |
| Приватные R2 files и scoped grants                          | Оставить                                                               | Это доступ и streaming, не дублирующий storage framework. Публичный bucket ради упрощения сломает приватность.                                                                   |
| Mutation outbox → native Queues → retries/DLQ               | Оставить                                                               | Outbox нужен для связи commit и доставки; at-least-once требует идемпотентности внешних эффектов. Не заменять durable jobs на fire-and-forget.                                   |
| Scheduler / alarm lifecycle                                 | Оставить                                                               | Используется существующий lifecycle, без always-on scheduler process. Не добавлять Workflows для каждого простого отложенного вызова.                                            |
| Immutable app releases / promote / rollback                 | Оставить                                                               | Они обеспечивают идентифицируемый код и возможность отката кода. Это не отдельный application service и не откат данных.                                                         |
| Platform install/update/adopt, lease и journal              | Оставить; улучшить operator flow                                       | Частичные ошибки облачных API реальны; journal и CAS не являются декоративным overengineering. Нужны точечные изменения Access/status/config, не второй installer.               |
| Bounded backup capsules и restore fence/pins                | Оставить опциональными; улучшить свежесть/политику                     | Для ценных данных нужен recovery. Для восстанавливаемых fixtures ежедневная ручная обязанность может быть избыточной, но её нельзя молча убрать из принятой политики.            |
| Health, bounded summaries, native Logs/alerts               | Оставить                                                               | Не строить собственную telemetry/billing платформу. Summary в панели — не все Workers Logs; тестовое письмо — не доказательство реального fault-trigger.                         |
| React SDK / общий client                                    | Оставить                                                               | Не добавлять Redux, отдельный query cache или event bus без конкретной необходимости. Reconnect/auth timers не являются polling базы.                                            |
| Astro shell + React dashboard                               | Оставить пока                                                          | Astro для client-only панели не обязательно нужен, но переход на Vite сейчас даёт небольшой выигрыш ценой CSP/assets/reproducibility regression. Не первоочередная переработка.  |
| Один lockfile / pinned toolchain / reproducible release     | Оставить; patch updates проверить                                      | Exact versions и immutable npm releases — нормальная воспроизводимость, а не enterprise deployment orchestration.                                                                |
| Acceptance scripts                                          | Упростить общую обвязку                                                | В старых harness повторяются OAuth-файл, local install descriptor, CF REST/SQL. Shared cleanup уже есть. Свести общую конфигурацию, не сценарии и не safety boundaries.          |
| Три canonical docs + архив                                  | Оставить; исправить мелкую неточность                                  | Историю не читать для установки. У runbook есть ссылка «improvement plan» на самого себя; удалить/исправить вводящий в заблуждение переход.                                      |
| Default customer и старые persisted names                   | Оставить совместимость                                                 | Старые SQL relationships/resource IDs/wire names не равны лишнему UI. Удалять только через объявленную миграцию с пользой, не ради «zero legacy».                                |

Supervisor + изолированный facet соответствует официальной [модели Durable Object Facets](https://developers.cloudflare.com/dynamic-workers/usage/durable-object-facets/). Узкие binding capabilities соответствуют [Dynamic Workers bindings](https://developers.cloudflare.com/dynamic-workers/usage/bindings/). Поэтому именно этот каркас уже нативный; «упростить» его переносом всего в общий unrestricted Worker было бы шагом назад.

## 4. Конкретные незакрытые места

### A. Capabilities есть в runtime, но нет обычного managed provisioning

**Доказательство:** [capabilities.ts](../../packages/core/src/capabilities.ts) (строки 4–12 и 74–95) читает `APP_CAPABILITIES` и Secrets Store binding. [workerConfiguration](../../packages/flare/src/cli/platform.mjs) (с 144) не формирует ни эту variable, ни Secrets Store bindings. Drift checks ограничивают ручные изменения managed Worker.

**Следствие:** приложение с внешним API/секретом нельзя полноценно настроить тем же стандартным lifecycle, которым устанавливается и обновляется панель. Это уже честно оговорено в архитектуре как незакрытый provisioning, а не новая найденная уязвимость.

**Минимальный путь:** одна явно операторская декларация scoped hosts и existing native secret references, validation и сохранение в managed state. Секретные значения не писать в state, app source или Git. Конкретный CLI интерфейс выбрать при реализации; не создавать новый секретный сервис.

**Приёмка:** отсутствие grant запрещает действие; grant действует только в выбранной среде; install/update/no-op не теряют grant; drift/recovery работают; ошибка не выдаёт account secret. Если эти capabilities сейчас не нужны — обозначить их unavailable в managed flow, не обещать работающую интеграцию.

### B. Access snapshot слишком широкий; reconciliation отсутствует

**Доказательство:** [assertAccess](../../packages/flare/src/cli/platform.mjs) (264–280) сравнивает digest полного ответа app. [configurationDigest](../../packages/flare/src/cli/platform-state.mjs) (377+) канонизирует все поля, не исключая response metadata.

**Локальная проверка:** два объекта с одинаковыми id/aud/domain, но разным `updated_at`, дают разные digests. Это подтверждение поведения hash; это **не** доказательство, что Cloudflare уже поменял metadata вашей текущей app или сломал update.

**Минимальный путь:** определённый semantic snapshot плюс явный подтверждаемый config-change flow. Host, audience, app identity и реальные security options сохраняют контроль. Смена policies должна проверяться отдельно в соответствии с текущим контрактом. Не разрешать любое drift, не игнорировать неизвестные значимые поля автоматически.

**Приёмка:** metadata-only change не блокирует; настоящий security drift блокирует; разрешённое изменение принимается явной операцией и выдерживает следующий update; CAS/lease сохраняются.

### C. Резервные копии: сортировка и операционная нагрузка

**Доказательство:** [BackupStore.list](../../packages/core/src/backups.ts) (144–173) возвращает ограниченную страницу R2 prefixes без порядка по `at`. CLI create генерирует random UUID: [cloud.mjs](../../packages/flare/src/cli/cloud.mjs) (297). R2 [выдаёт объекты по ключу](https://developers.cloudflare.com/r2/api/workers/workers-api-reference/), не по времени создания.

**Следствие:** первая строка/первая страница не доказывает, что найден самый свежий completed backup. Сортировка только 20 записей не решает глобальную задачу.

**Минимальный путь:** надёжное bounded представление latest completed backup + его age; журнал completion на владельце scope или другой маленький индекс с явной reconciliation. После удаления latest корректно обновлять указатель. Не сканировать все manifests на каждое открытие Settings; старые UUID capsules сохранять.

**Политика:** согласованные RPO 24 часа / RTO 1 час сейчас требуют ручного ежедневного действия. До следующего completed backup возраст recovery point растёт; backup перед обновлением не обеспечивает ежедневный RPO. Фактическая свежесть личных backups в этом проходе не проверялась.

Если ручная обязанность не устраивает, выбрать одно: ограниченный native schedule с проверенным completion/quiet boundary, либо явно пересогласованная on-demand политика для некритичных данных. Это решение владельца, не повод автоматически строить DR subsystem.

Cloudflare [документирует PITR для SQLite DO](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/#pitr-point-in-time-recovery-api). Но coordinated recovery Supervisor + facet + R2 files + app release здесь не реализован и не проверен. Нельзя объявить PITR заменой capsule recovery без отдельного доказательства.

### D. `platform status` — checkpoint, не live health

**Доказательство:** [runPlatform](../../packages/flare/src/cli/platform.mjs) (927–937) возвращает public installation state до preflight/readiness.

**Минимальный путь:** явно отделить `installation.status` от `health`: bounded read-only проверка ожидаемых endpoints/resources по запросу оператора. Timeout/Access denial должны означать «не удалось проверить», а не «healthy» или «not installed». Без heartbeat daemon и периодических запросов.

**Приёмка:** сохранённая installation с недоступным Runtime не выглядит здоровой; Access challenge не выдаётся за отсутствие установки; команда ничего не меняет.

### E. Dashboard не полностью realtime

**Доказательство:** [useResource](../../packages/core/dashboard/src/components/common.tsx) (50–92) делает snapshot и обновляет его при focus/visibility/refresh. Это безопасно и без interval polling, но changes другого клиента не доставляет.

**Минимальный путь, если нужен:** один Access/membership-authorized канал выбранной среды с invalidation hints; существующие bounded reads обновляют только открытый экран. Reconnect делает resync, revocation закрывает канал. Не копировать app query protocol, не заводить tenant-wide event bus.

**Приёмка:** изменение SDK-клиента видно в открытом Data view без focus/reload; cross-user/scope запрет; reconnect не теряет итоговое состояние; один канал на активную среду. Для одного оператора это UX улучшение, а не блокер самого backend.

## 5. Поддерживаемость: где реально можно уменьшить работу

### Исходники

`runtime.ts` — 2245 строк, `platform.mjs` — 1281. Размер затрудняет навигацию, но сам по себе не доказывает плохую архитектуру.

Безопасная последовательность: уточнить DTO у существующих admin/file/schedule операций; затем при необходимости вынести stateless transport/validation helpers. State machine activation/recovery, serial gate, storage ownership и alarm lifecycle не растаскивать по независимым сервисам.

### Cloud harness

Некоторые старые acceptance scripts напрямую читают Wrangler OAuth из macOS `default.toml` и `.private/flare-install.json`; более новый lifecycle harness использует platform primitives. Это расходящиеся пути эксплуатационной обвязки, не дополнительная runtime infrastructure.

Использовать один явный источник account/auth/managed resource descriptor и общий bounded API helper. Каждый сценарий сохраняет собственные fixtures, assertions и fixed-scope cleanup. Не менять passing tests массовым абстрактным «framework refactor».

### Обновления toolchain

Кандидаты из registry на дату проверки:

| Зависимость           | Сейчас → кандидат           | Решение                                                                                                |
| --------------------- | --------------------------- | ------------------------------------------------------------------------------------------------------ |
| Workers types         | 5.20261010.1 → 5.20261013.1 | Небольшой update, проверить compile/native compatibility.                                              |
| Wrangler              | 4.149.0 → 4.150.0           | Обновлять одновременно manifests и pinned CLI release constant; native/reproducible gates обязательны. |
| Bun types             | 1.4.2 → 1.4.3               | Малый update, проверить typecheck. Сам Bun уже 1.4.3.                                                  |
| Prettier Astro plugin | 1.1.0 → 1.1.1               | Малый update, проверить formatting/build.                                                              |
| Node types            | 24.19.2 → 26.6.5            | Не переходить вслепую на новый major: CI Node 24. Проверить подходящий update в линии 24.              |
| TypeScript            | 6.0.2 → 7.0.2               | Отдельная compatibility проверка Astro/declarations/Bun build; не просто сменить major.                |

Это **кандидаты**, не проверенные обновления и не security findings. Compatibility date не поднимать автоматически вместе с patch dependencies. Существующие production dependencies не требуют массовой замены по результату этого `bun outdated`.

## 6. Что не следует добавлять сейчас

- Вторую БД app data, ORM или schema builder в панели.
- Worker/очередь/каталог на каждый маленький app.
- Собственный identity provider, event bus, cache cluster или scheduler service.
- Workflow orchestration для каждого обычного job.
- Always-on monitoring, polling панели или keep-warm.
- Автообновление Core без operator approval и evidence.
- Автоматический replay внешних effects после неоднозначной ошибки.
- Enterprise backup UI, off-account DR и occupied-target restore без потребности.
- Общую «универсальную» RPC/acceptance abstraction ради сокращения строк.
- Удаление совместимых persisted names, FK/customer metadata, fences/pins и retained copies ради чистого поиска слова legacy.

## 7. Порядок следующих работ

1. **Operator flow:** Access semantic drift + понятный status. Локальные regression checks, затем disposable cloud update. Не трогать существующие policies молча.
2. **Нужные интеграции:** managed capabilities только если есть конкретный app с external API/secrets; иначе документировать ограничение.
3. **Recovery UX:** latest completed/age; отдельно решение о ежедневной политике. Существующие copies сохранить.
4. **Dashboard UX:** узкая push-инвалидация, если действительно нужна актуализация от SDK/второй вкладки.
5. **Maintenance:** проверенные toolchain patch updates, общая cloud harness обвязка, DTO и одна неправильная ссылка. Ничего из этого не требует миграции app data.

Независимый account, полный graceful drain и off-account recovery остаются непроверенными; отсутствие второго аккаунта не нужно маскировать PASS. Preview tag и нативные экспериментальные API также не исчезают от косметического refactor.

**Итог:** текущая архитектура не требует нового большого этапа «перестроить всё». Нужны несколько ограниченных улучшений нормального operator flow и честные границы возможностей. Большая часть прежних упрощений уже выполнена; повторно удалять полезные safety механизмы не следует.
