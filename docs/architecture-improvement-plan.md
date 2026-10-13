# Flare: план перехода к более простой и поддерживаемой архитектуре

**Дата:** 12 октября 2026 года.  
**Исходная версия:** 0.3.5, protocol 1, runtime ABI 4.  
**Базовый commit:** `6627523c18c74d6f24a242d89cf16ba462b83baa`.  
**Статус на 13 октября 2026 года:** переход завершён в согласованном scope. A–E проверены с ограничениями ниже; F сознательно пропущен. G выполнен: опубликованная `0.3.6` под `next`, личная панель обновлена обычным опубликованным CLI. `latest` остаётся `0.3.1`.

## 1. Цель и границы

Сохранить работающую Cloudflare-native архитектуру, убрать неоднозначные контракты и устаревшие пути эксплуатации, затем подтвердить надёжность для выбранного production workload.

**Не переписывать платформу. Не добавлять инфраструктуру ради рефакторинга.** Изменение принимается, только если оно уменьшает число источников истины, делает контракт явнее или закрывает проверяемый риск.

Документ определяет порядок работ. [Архитектура](architecture.md) описывает реализацию, [platform lifecycle](platform-lifecycle.md) — установку/обновление, [maintenance](maintenance.md) и [runbook](production-runbook.md) — ограничения и эксплуатацию. Новые эксплуатационные инструкции следует согласовывать с ними, а не поддерживать несколько расходящихся копий.

### Уже сделано — не выполнять заново

- Managed CLI `install/status/update/adopt`, D1 journal, CAS/lease и recovery checkpoints.
- Explicit adoption личной установки с сохранением данных, ресурсов, namespaces, signing secrets и Access.
- Cloud upgrade 0.3.4 → 0.3.5 с проверкой data/auth/files/pending job и scoped cleanup.
- Воспроизводимый platform payload и публикация точного проверенного архива 0.3.5 под `next`.
- SDK realtime через hibernating WebSocket без polling данных.
- Ограниченный logical backup/restore в другую пустую среду того же проекта.

Эти доказательства не заменяют нагрузочную приёмку, полный concurrent crash/drain тест или проверенную доставку alerts.

## 2. Архитектурные инварианты

Эти границы не менять в рамках перехода:

1. **Два общих Worker:** Admin для управления, Runtime для приложений. Не создавать Worker на каждый проект.
2. **Один Supervisor на project UUID/environment:** он владеет состоянием, serial gate, Lifecycle, sockets и alarms.
3. **Постоянный facet `app` с собственной SQLite:** документы отделены от служебной SQLite Supervisor. Не удалять/recreate facet или namespace при обновлении.
4. **D1 — control plane**, не база документов приложения и не обязательная зависимость каждого application request.
5. **R2 BUNDLES и FILES остаются приватными; Queues используются для доставки jobs.** Не создавать заменяющий их брокер или отдельный scheduler.
6. **Mutation + revision + job outbox остаются одной SQLite-транзакцией.** Внешние effects остаются at-least-once, не объявляются exactly-once.
7. **Service bindings/RPC остаются нативными.** Не заменять их внутренним HTTP, JSON-RPC-фреймворком или service discovery.
8. **Авторизация разделена:** Cloudflare account token, Access/membership, project deploy credential и app-user session не взаимозаменяемы.
9. **Один публичный SDK/CLI-пакет**, один Bun workspace/lockfile, immutable releases. Account credentials не попадают в browser SDK, D1 installation state или application code.
10. **Совместимость сохраняется:** публичные exports, HTTP/WebSocket wire format, error codes, schema/storage identifiers, UUID scopes и retained app releases.

Простая целевая схема остаётся прежней:

```text
Access → Admin → D1 catalogue / installation journal
             ↕ native service RPC
SDK / app CLI → Runtime → EnvironmentSupervisor
                              ├─ SQLite служебного состояния
                              ├─ persistent AppFacet → SQLite документов
                              ├─ Dynamic Action → scoped capabilities
                              ├─ R2 releases / backups / files
                              └─ transactional outbox → Queues / DLQ
```

## 3. Порядок перехода

| Этап | Работа                                                         | Результат                                                 |
| ---- | -------------------------------------------------------------- | --------------------------------------------------------- |
| A    | Актуализировать документацию и основной flow                   | Один понятный путь эксплуатации                           |
| B    | Типизировать внутренние RPC-контракты                          | Изменения интерфейсов проверяет компилятор                |
| C    | Согласовать managed-конфигурацию, bindings и examples          | Нет параллельных источников production-конфигурации       |
| D    | Выполнить production-приёмку и исправить обнаруженные проблемы | Доказательства для выбранного workload и failure cases    |
| E    | Проверить recovery, alerts и DLQ-процедуру                     | Понятная эксплуатация без собственного monitoring-сервиса |
| F    | Условно разгрузить большой Runtime                             | Меньше связанного кода, без новой инфраструктуры          |
| G    | Выпустить новую immutable версию и обновить панель обычным CLI | Проверенный переход от точного опубликованного архива     |

**A–C — небольшой обязательный проход по поддерживаемости. D–E важнее косметического рефакторинга. F не блокирует production, если не даёт явного выигрыша.** Найденные в D ошибки исправлять и повторно проверять до выпуска G.

## 4. Этап A — документация и один путь эксплуатации

### Сделать

- [x] Исправить в `docs/architecture.md` текущие примеры с 0.3.2; отличать актуальную команду от исторического evidence.
- [x] Заменить старое описание React island на фактический client-only mount через Astro bundled script.
- [x] Описать публикацию точного архива, прошедшего package acceptance, без последующего repack.
- [x] Согласовать карту с native-platform и reproducibility gates текущих workflows.
- [x] Во всех основных инструкциях оставить managed flow: точная версия CLI → `status` → `update --dry-run` → подтверждённый `update`.
- [x] Пометить legacy setup/private Wrangler configs как исторический operator/recovery путь, а не альтернативный deploy managed-установки.
- [x] Не удалять private configs, signing material или backup artifacts ради очистки документации.

### Готово, когда

- Нет противоречащих друг другу текущих version/flow описаний; исторические версии явно обозначены.
- Все локальные ссылки разрешаются, formatting и consistency tests проходят.
- Документация не обещает автоматический updater, атомарный rollout или полностью push-reactive dashboard.
- Никаких cloud writes на этом этапе нет.

## 5. Этап B — явные RPC-контракты

### Исходная проблема (в 0.3.5)

В `packages/core/src/admin.ts` и `runtime.ts` используются динамические `Proxy`, строковые `command/dispatch`, `any[]` и выбор метода по строке. Allowlist и сериализуемый error envelope уже существуют; задача — уменьшить неявные связи, а не заменить работающий транспорт.

### Сделать

- [x] Ввести небольшой общий type-only контракт операций, tuples аргументов и результатов, например `packages/core/src/rpc-contract.ts`.
- [x] Типизировать вызовы Admin → RuntimeControl и Runtime → Supervisor; импортировать implementation types только через `import type`, не подтягивать Runtime code в Admin bundle.
- [x] Убрать `any` на границе контракта там, где форма известна; недоверенные входы принимать как `unknown` и проверять существующими validators.
- [x] Заменять динамический Proxy небольшим явным adapter только там, где это действительно упрощает код. Не создавать универсальную RPC-фабрику.
- [x] Сохранить `RpcResult`, `capture/unwrap`, deliberate public error codes и скрытие private error messages.
- [x] Сохранить runtime allowlists, auth/scope guards, Lifecycle start и deletion/restore fencing. TypeScript не заменяет эти проверки.
- [x] Сохранить существующие wire method/operation names. Старый Admin должен работать с новым Runtime на промежуточной стадии последовательного update.

### Проверить

- Неверная операция/форма аргументов известного вызова отклоняется компилятором.
- Runtime guards отклоняют неизвестные операции и невалидный scope.
- Через настоящий workerd RPC сохраняются error codes, `false` и `null`; внутренние stack/message не возвращаются клиенту.
- Admin/Runtime и Dynamic Worker bundle boundaries не меняются.
- Retained application bundles не требуют rebuild из-за внутреннего core refactor.

**Готово:** существующий wire contract сохранён, targeted tests и native kernel/platform gates проходят. Если необходима несовместимая смена wire methods/ABI, вынести её в отдельный миграционный план, не прятать в этот рефакторинг.

## 6. Этап C — конфигурация без нового DSL

### Сделать

- [x] Использовать существующую `workerConfiguration()` в CLI lifecycle как основной генератор managed deployment configuration.
- [x] Проверять тестами соответствие обязательных binding names, entrypoints и типов Env фактической конфигурации Workers.
- [x] Согласовать `*.wrangler.example.json` с текущими контрактами и явно обозначить их назначение. Не подменять ими managed configuration.
- [x] Сохранить отличия стандартного adopted operator layout: legacy resource names/IDs, rate-limit namespace и custom domains. Не нормализовать их переименованием.
- [x] Сохранить отказ legacy setup при наличии managed D1 journal; проверить отсутствие обходного public shortcut для direct Admin/Runtime deploy.
- [x] Удалять старые scripts/helpers только после проверки usages и переноса нужной acceptance-проверки. Private operator artifacts автоматически не удалять.
- [x] Не объединять platform configuration с frontend/landing deployment: это разные lifecycle.

### Готово, когда

- Install/update/adopt используют один lifecycle engine; recovery не уходит в ручной deploy.
- Native service bindings, Loader, DO export, assets, Queue/DLQ и private R2 заданы согласованно.
- No-op update не меняет версии Workers, Access, secrets или namespace IDs.
- Drift по-прежнему приводит к явному отказу, а не silent merge/reset.

**Не добавлять:** configuration DSL, plugin registry, generic deployment orchestrator, альтернативный installer или собственную реализацию vendor tooling.

## 7. Этап D — одна production-приёмка, а не набор новых сервисов

### Согласованный профиль

10 одновременных клиентов, 20 live-подписок, 5 query/s и 1 mutation/s, 10 минут. Порог p95 query/mutation < 1 секунды; ноль неожиданных ошибок и потерянных подтверждённых записей. Это приёмочный профиль, не SLA. Политика восстановления: RPO 24 часа / RTO 1 час. Отдельный предел облачного расхода пока не согласован.

### Перед запуском

- [x] Определить workload: число concurrent users/subscriptions, query/mutation rate, объём документов/файлов и jobs.
- [x] Длительность и latency/error thresholds согласованы до теста. Actual billing/cost threshold не проверены; это явное ограничение, а не произвольный PASS по расходу.
- [x] Использовать отдельную disposable установку/проект на существующем аккаунте. Второй аккаунт для этой приёмки не требуется; его отсутствие записать как оставшееся ограничение.
- [x] Использовать точные source/target archives; CLI/SDK установить вне repository workspace. Для реального platform flow вызывать compiled CLI, а не считать injected source-engine test его заменой.
- [x] Зафиксировать начальный inventory и identities; credentials не выводить в отчёт.
- [x] Fault injection и имитацию внешних effects держать только в изолированном harness/fixture, не в production bundle.

### Обязательная матрица

| Сценарий                                          | Проверяемый результат                                                                                            |
| ------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| Два app-users, два окружения                      | В fixture handlers проверяется ownership; чужие reads/writes/live results и cross-environment access отклоняются |
| Concurrent mutation/query/subscriptions           | Нет потерянных подтверждённых записей; snapshots соответствуют committed данным; errors/latency измерены         |
| Reconnect, истечение/отзыв сессии                 | Авторизованный reconnect получает актуальный snapshot; revoked identity больше не получает данные                |
| Mutation: commit выполнен, ответ потерян          | Клиент видит неоднозначный результат, не делает слепой retry; состояние проверяется чтением                      |
| Повторная доставка Queue job                      | Fixture external effect идемпотентен; нет ложного обещания exactly-once                                          |
| Activation при running action/job                 | Либо контролируемый `CONFLICT`, либо проверенное завершение операции; checkpoint не теряется                     |
| Crash после candidate journal и schema commit     | Recovery сохраняет IDs/данные и корректно завершает activation либо остаётся явно fenced/not-ready               |
| Update exact source → target                      | Сохраняются данные/auth/file bytes/pending job, namespaces, resource identities, Access и secrets                |
| Прерванный platform deploy / cache-free discovery | Resume согласует outcome без duplicate deploy; завершённое состояние обнаруживается из D1                        |
| Прерванный/повреждённый restore                   | Неуспешный target остаётся fenced; исправление причины и повтор той же capsule завершают restore                 |
| Cleanup                                           | Удалены только собственные disposable resources; итоговый inventory совпадает с исходным                         |

### Если выявлена проблема

1. Сохранить воспроизводимый failure case и фактический outcome.
2. Добавить regression test.
3. Исправить минимальный участок, не заменяя весь subsystem.
4. Повторить failed case и соседний success/recovery path.
5. Обновить evidence и ограничения.

**Готово:** матрица пройдена для заявленного workload, cleanup подтверждён, исходные failures сохранены отдельно. Cancelled/неисполненный soak, mocked test или successful deploy сами по себе не считаются production acceptance.

Пока полный graceful drain не доказан, использовать явное maintenance window: pause cron, проверить отсутствие running jobs/actions/uploads, выполнить согласованную операцию, затем возобновить работу. Не удалять pending jobs/DLQ для имитации quiet state и не считать просмотр dashboard достаточным доказательством drain.

## 8. Этап E — recovery и incident ownership

- [x] Определить ответственного оператора, допустимые RPO/RTO и ограничения текущего logical backup.
- [x] Выполнить восстановление выбранного fixture workload в другую пустую среду того же проекта: сверить IDs, release, document values, file bytes и пользователей.
- [x] Exclusions явно зафиксированы по backup contract: active sessions, secrets, origin/auth settings, cron и jobs не восстанавливаются автоматически; проверки не заявляют их перенос.
- [x] Настроить доступные native Cloudflare alerts/notifications для ошибок и выбранных usage thresholds; тестовым событием подтвердить доставку оператору. Наличие Logs не равно настроенным alerts.
- [x] Описать DLQ triage: scope/job/release, попытки, возможный external effect, проверка идемпотентности и условия явного replay/reconciliation.
- [x] Установить backup cadence и retention без добавления своего always-on daemon. Если автоматизация действительно нужна для RPO, выбирать отдельно доступную native возможность и проверять её результат.
- [x] Зафиксировать expiry/renewal scoped account token. Его истечение блокирует административные CLI-операции, а не само исполнение уже развёрнутого приложения.

**Готово:** recovery rehearsal выполнен, alerts реально доставлены, оператор может выполнить incident procedure по runbook. PITR/off-account/in-place restore не заявляются готовыми и не добавляются без отдельной необходимости приложения.

## 9. Этап F — условный модульный рефакторинг Runtime

**Решение:** отдельное разбиение activation/jobs/restore сейчас пропустить. В B уже вынесены type-only RPC и binding-контракты, удалены динамические Proxy и дублирование Env. Дополнительный перенос concurrency/state orchestration потребует больше adapters, чем даст пользы; инфраструктура и ownership Supervisor сохраняются.

`runtime.ts` совмещает несколько обязанностей и составляет примерно 2 300 строк в базовом состоянии. Это повод рассмотреть границы кода, не доказательство архитектурной ошибки и не требование снизить число строк.

### Делать только при явном выигрыше

- Выделять по одному самостоятельному участку: release/activation orchestration, job/outbox handling, backup/restore orchestration или transport adapters.
- Переиспользовать существующие `auth`, `files`, `backups`, `reactivity`, `queue`, `release`, `maintenance` helpers, а не создавать параллельные реализации.
- Передавать только необходимые зависимости/операции. Не создавать «контекст со всем Supervisor», service container или универсальный plugin lifecycle.
- Оставить durable state, concurrency ownership, sockets/alarms и fences у исходного Supervisor.
- Не менять SQL schema, facet name, loader identity, scope key или ordering транзакций ради разбиения файла.

**Готово:** выбранный модуль проще читать/тестировать, native/crash regressions не изменились, нет новых bindings/services. Если перенос создаёт больше adapters и циклических зависимостей, пропустить F; production-приёмку не откладывать ради косметики.

## 10. Этап G — безопасный выпуск и переход личной установки

### Локальные gates для кодовых изменений

```sh
bun install --frozen-lockfile --ignore-scripts
bun run verify
bun run test:kernel
bun scripts/platform-native-acceptance.mjs
bun run test:platform:reproducible
bun audit --production --audit-level=high
bun scripts/verify-package-artifact.mjs
git diff --check
```

Между небольшими правками достаточно targeted tests; полный набор обязателен перед фиксацией release candidate. Документационный этап не требует cloud deploy.

### Переход

1. Выпустить изменения только в **новой immutable версии**. Не менять опубликованную 0.3.5.
2. Синхронизировать workspace versions/lockfile; заявлять в `upgradeFrom` только реально проверенные source versions. Для перехода с текущей установки проверять точную опубликованную 0.3.5.
3. Проверить промежуточную пару старый Admin / новый Runtime; Worker update остаётся последовательным.
4. Выполнить declared cross-version cloud gate на двух фиксированных archives; целевой payload должен совпасть с release candidate.
5. После отдельного подтверждения публикации запустить защищённый workflow; публиковать тот archive, который прошёл acceptance, без repack. `latest` не менять без отдельного решения.
6. Установить опубликованный package вне repository; сверить integrity, все payload hashes, SDK imports и CLI help.
7. Для личной панели сначала выполнить `status` и `update --dry-run`; проверить допустимый переход, затем выполнить подтверждённый `update` точной версии CLI.
8. Проверить реальные readiness, Access owner login, identities, данные и file bytes; повторный same-release update должен быть no-op.
9. Обновить evidence и документацию. Отчёт содержит source/target versions/digests, scope, команды, результаты и cleanup; credentials/private raw logs остаются локально.

Сохранять исходный archive, logical backup и Worker version IDs. Это recovery evidence, **не автоматический data rollback**. При ambiguous outcome остановить дальнейшие writes, проверить journal/фактическое состояние и продолжать ту же операцию/версию; не переключаться на direct Wrangler deploy или downgrade.

## 11. Что не входит в переход

- Полностью realtime dashboard: отдельная функциональная задача, не production prerequisite.
- K2/event streams, новый message broker, Workflow engine или отдельный monitoring server.
- Automatic sharding, cross-project transactions, публичный untrusted-code marketplace.
- Перенос документов в D1, объединение Supervisor и AppFacet SQLite, Worker на каждый project.
- Возврат ORM/Drizzle/legacy ABI, новое generic storage/repository abstraction.
- Автоматический updater, generic config reconciliation, слепой retry mutations/jobs или automatic DLQ redrive.
- Полноценный identity product, обязательный external OIDC, Secrets Store/egress без реального использования приложением.
- Атомарный frontend/backend release, PITR и off-account DR «на всякий случай».

Эти возможности рассматривать отдельно только по измеренной потребности. Независимый Cloudflare account остаётся непроверенным; это ограничение общей дистрибуции, не причина блокировать согласованную приёмку личной установки.

## 12. Итоговый checklist

- [x] A: документация соответствует source, manifests и workflows; основной flow один.
- [x] B: RPC типизирован, error/permission/wire contracts сохранены.
- [x] C: configuration/bindings/examples согласованы; нет второго production deploy пути.
- [x] D: согласованный workload и failure cases проверены отдельными cloud/native reports; исправлен fixture, cleanup подтверждён. Это не общий SLA или полный cloud chaos/drain тест.
- [x] E: recovery rehearsal, policy, тестовая alert delivery и DLQ ownership закрыты в описанных границах.
- [x] F: выполнен только полезный модульный перенос либо записано решение пропустить его.
- [x] G: новая версия опубликована после отдельного подтверждения; личная панель обновлена через CLI и проверена.
- [x] Нет новых инфраструктурных сервисов, background polling, reset данных/namespaces или расширения account scope ради рефакторинга.
- [x] Оставшиеся ограничения явно записаны; успешные локальные gates не названы полной production certification.

## 13. Текущие доказательства и незакрытые пункты

- A–C: полный verify, TypeScript/Astro, native kernel/platform и воспроизводимость payload прошли. После fixture regression suite содержит 395 tests. Production dependency audit: vulnerabilities не обнаружены. В RPC остаются существующие вложенные admin/file payloads; этот проход не объявляет весь subsystem полностью типизированным.
- Первый облачный запуск 0.3.6 прерван до завершения: результат `INTERRUPTED`, не PASS. Его disposable ресурсы удалены; исходный inventory восстановлен и fingerprints совпали.
- Повторная приёмка остановлена на HTTP 500 Cloudflare assets-upload-session при deploy Admin. Failure report сохранён отдельно; scoped cleanup PASS, inventory совпал. Production workload ещё не был запущен.
- Harness теперь записывает каждый пройденный этап; production-hook evidence сохраняется до удаления scratch даже при ошибке.
- Следующая изолированная приёмка подтвердила переход 0.3.5 → 0.3.6, CLI no-op, два app-user/environment и 20 live-подписок. Нагрузка: 3000 queries / 600 mutations, p95 244/263 мс, ноль unexpected/live errors, все подтверждённые записи сверены. Измеренный интервал запросов 599.865 секунд при nominal 600-секундном расписании; harness дополнен явным ожиданием конца полного окна для следующих запусков.
- После нагрузки обнаружена ошибка fixture: internal jobs специально имеют `auth: null`, а fixture требовал пользовательский `ctx.auth`. Исправлен только fixture: owner выводится из авторизованной scheduling mutation и передаётся явно в internal arguments. Runtime safeguards не ослаблены. Regression через настоящий local workerd/Queue прошёл; authenticated client по-прежнему не может вызвать internal mutation.
- Native regression activation при running Queue job прошёл: `CONFLICT`, admitted mutation сохранена, job завершён, active release не изменён.
- Полный cloud report предыдущего запуска остаётся `FAIL`, хотя workload и upgrade прошли; Queue retry/recovery не объявлены прошедшими. Повторный **recovery-only** сценарий использует те же exact platform archives и 600 seed records, но явно отмечает `workload: NOT_RUN`; он не подменяет повторную нагрузочную приёмку.
- Финальная recovery-only приёмка **PASS**, cleanup **PASS**, исходный inventory совпал. Проверены native Queue retry/duplicate receipt, реальный short-lived JWT expiry, corrupted-file fencing и retry той же capsule. Capsule: 604 rows / 1 file; через логины обоих пользователей сверены ID и полные значения 601 owned documents (600 workload-equivalent + начальный ownership record), file bytes и active release. Восстановление с повреждением/исправлением и проверками заняло 9.229 секунды; это результат fixture, не обещание для произвольного объёма.
- Все первоначальные failures сохранены отдельно: прерывание, assets HTTP 500, fixture owner, неверный test-count (начальная ownership-запись), временный helper route HTTP 404. Никакой из этих отчётов не переписан в PASS. Readiness helper теперь проверяет тот же URL, который используется POST; mutating bootstrap не повторяется автоматически.
- Backup cadence: ежедневный operator backup и обязательный backup перед рискованным изменением; automatic timer не установлен. RPO 24h зависит от выполнения этой процедуры оператором, а не от наличия разового backup.
- Native account-wide budget alert $10 создан отдельно для оператора; Cloudflare принял test dispatch, владелец подтвердил получение email. Existing policy не изменена. Worker errors (только два personal Worker) и jobs dead-letter transitions (только personal queue) настроены, readback проверен и владелец подтвердил оба тестовых письма. Реальный fault-to-rule trigger на личной панели не выполнялся. DLQ telemetry sampled и не является непрерывным backlog gauge. Account-wide budget не подменяет Flare-only monitoring.
- Независимый аккаунт, полный graceful drain и off-account DR остаются явно непроверенными. Публикация 0.3.6 и обновление личной панели завершены; независимая установка не заявляется.

- G: [защищённый workflow 38385348118](https://github.com/auersperg/flare/actions/runs/38385348118) и CI прошли на commit `602d57c`. Registry archive SHA-256 `515031f93043b8c7d0ea9771b25c2c863073bee0d47d67e85c22ea4fbed6c1ad` совпал с принятым архивом; все 63 установленных файла сверены вне repository. Проверены Node SDK imports и compiled CLI help.
- Личная панель: четыре завершённых pre-update backup, внешний опубликованный CLI `status` → `update --dry-run` → подтверждённый `update` 0.3.5 → 0.3.6. Реальные readiness, owner Access login, оба проекта, четыре среды, все документы/schema/releases/users/auth settings/file metadata и SHA-256 file bytes сохранены. Повторные dry-run и подтверждённый update — no-op без новых Worker versions. Fixed-scope audit Worker удалён, временные credentials стёрты. Evidence: `artifacts/platform-036-registry-acceptance.json`, `artifacts/platform-036-personal-update-acceptance.json`.
- Во время owner login обнаружен старый основной домен Access `dashboard.auer.wien` и ссылка на удалённый Worker. По отдельному запросу владельца основной destination исправлен на `dash.flare.auer.wien`; app ID/audience/policies/session/security settings сохранены. Однократное подтверждённое изменение конфигурации зафиксировано через существующий D1 lease/CAS; drift guard не отключался. Это operator repair, не новый generic reconciliation или альтернативный platform deploy.

**Критерий остановки:** для выбранного приложения подтверждены корректность, восстановление и эксплуатация; контракты и normal flow понятны; полезные упрощения завершены. Не продолжать рефакторинг ради «идеальной архитектуры».
