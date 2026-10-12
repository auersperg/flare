# Flare — полная карта текущей архитектуры

Зафиксировано **12 октября 2026 года** по исходникам, manifests, CI workflows и конфигурациям установки. Базовый commit до обновления документа: `8e4a451`. Версия исходников **0.3.4**, протокол **1**, runtime ABI **4**.

**Статус:** работающая self-hosted установка для доверенной команды; preview, не полный Convex replacement и не сертификация всех production-гарантий. Ниже разделены реализованные механизмы, состояние конкретной установки и незавершённые возможности. Это карта фактической реализации, а не первоначальный план Reactive/Flared.

## Содержание

1. [Продукт и границы](#1-продукт-и-границы)
2. [Общая схема](#2-общая-схема)
3. [Репозиторий и пакеты](#3-репозиторий-и-пакеты)
4. [Стек и сборка](#4-стек-и-сборка)
5. [Control plane](#5-control-plane)
6. [Data plane и Dynamic Workers](#6-data-plane-и-dynamic-workers)
7. [Данные и схема](#7-данные-и-схема)
8. [Функции и контекст](#8-функции-и-контекст)
9. [Реактивность](#9-реактивность)
10. [Dashboard](#10-dashboard)
11. [Три независимые границы авторизации](#11-три-независимые-границы-авторизации)
12. [SDK и протокол](#12-sdk-и-протокол)
13. [CLI и developer flow](#13-cli-и-developer-flow)
14. [Релизы и frontend](#14-релизы-и-frontend)
15. [Файлы](#15-файлы)
16. [Задания и расписания](#16-задания-и-расписания)
17. [Backup и удаление](#17-backup-и-удаление)
18. [CI и npm publishing](#18-ci-и-npm-publishing)
19. [Эксплуатация и экономия](#19-эксплуатация-и-экономия)
20. [Проверки и оставшиеся границы](#20-проверки-и-оставшиеся-границы)
21. [Навигация по исходникам](#21-навигация-по-исходникам)
22. [K2 — расширение, не текущий компонент](#22-k2--расширение-не-текущий-компонент)

## 1. Продукт и границы

Flare — собственный backend-as-a-service в Cloudflare аккаунте оператора: одна установка core обслуживает несколько приложений. Cloudflare хранит и исполняет backend; локально работают CLI, сборщик и frontend dev server. Постоянной Bun/Node VM нет.

Иерархия управления: **установка → customer/workspace → project UUID → dev/prod**. Customer — группировка проектов, не отдельная инфраструктурная установка и не реализованная система делегированных прав заказчикам. Сейчас membership owner/editor/viewer относится к установке, а deploy credential ограничен проектом.

Каждая среда имеет независимые данные, пользователей/пароли/сессии, origin/auth настройки, active release, файлы, задания и подписки. Ключ backend-хранилища: `<project UUID>/<dev|prod>`. Переименование проекта или URL alias не меняет этот ключ.

Frontend приложения — отдельный проект и отдельный hosting deployment. Статическому лендингу не обязательно подключать Flare. Expo и другие клиенты могут обращаться к HTTP/WebSocket протоколу; готовые отдельные Rust/Go SDK пока не реализованы.

## 2. Общая схема

```text
Оператор / разработчик
  ├─ Browser → Cloudflare Access → Admin Worker + Static Assets
  │                                  ├─ D1: каталог / membership / аудит
  │                                  └─ RuntimeControl service RPC
  └─ Bun CLI → /control/api/* → AdminControl service RPC
                                     │
                                     ▼
Frontend / серверный SDK → Runtime Worker
                          ├─ route / rate limit / origin / identity
                          ├─ R2 alias mapping (только холодный lookup)
                          └─ Supervisor DO [project UUID / environment]
                               ├─ собственная SQLite платформы
                               │    auth / activation / subscriptions / jobs / files
                               ├─ Lifecycle + WebSockets + Scheduler
                               │    физические WebSocket и alarm
                               ├─ persistent facet "app"
                               │    Dynamic Worker AppFacet
                               │    отдельная SQLite приложения
                               └─ Dynamic Worker Action
                                    scoped AppCapability → query/mutation/files/cron

R2 BUNDLES: immutable code + route mappings + backup capsules
R2 FILES: приватные bytes файлов
Facet outbox → Supervisor recovery → Queues JOBS → Action
                                              └─ retries → DLQ
DynamicTail → console → Cloudflare Workers Logs
```

Два основных Worker — **Admin и Runtime**, общие для всех проектов. Landing — дополнительный static Worker; Workers клиентских frontend не являются backend Worker на каждый Flare project. D1 и dashboard не нужны для каждого клиентского запроса уже настроенной среды.

Установка AUER на момент фиксации:

| Назначение               | Ресурс / адрес                                                 |
| ------------------------ | -------------------------------------------------------------- |
| Landing                  | `flare-landing` → `https://flare.auer.wien`                    |
| Dashboard                | `flare-admin` → `https://dash.flare.auer.wien`                 |
| API и management gateway | `flare-runtime` → `https://api.flare.auer.wien`                |
| SQLite DO                | namespace класса `EnvironmentSupervisor`, один объект на среду |
| Каталог                  | D1 `flare-catalog`                                             |
| Сборки / backups         | R2 `flare-builds`                                              |
| Файлы                    | R2 `flare-files`                                               |
| Работа / dead letters    | `flare-jobs` / `flare-jobs-dlq`                                |

У core и landing `workers_dev: false`, `preview_urls: false`; публичные адреса — custom domains. Secret values, персональные записи пользователей, рабочие resource IDs и сырые логи в эту карту не включаются. Полный account inventory/ночные измерения находятся в ignored `.private/audits`, а не в публичной документации репозитория.

## 3. Репозиторий и пакеты

```text
flare/
├── .github/workflows/     ci.yml и publish.yml
├── packages/
│   ├── flare/             публичный SDK + CLI в одном npm-пакете
│   │   ├── src/sdk/       client, server, native data/runtime, React, protocol
│   │   ├── src/cli/       команды, build, cloud, login, project discovery
│   │   └── dist/          генерируется сборкой, не исходники
│   └── core/              приватный workspace-пакет платформы
│       ├── src/           Admin/Runtime и platform services
│       ├── dashboard/     Astro + React + shadcn, вложенный workspace
│       ├── migrations/    административные D1 migrations 0001–0006
│       ├── bootstrap/     пустое приложение для нового проекта
│       ├── landing/       static HTML заглушка
│       ├── *.wrangler.example.json
│       └── dist/          генерируемые Workers, dashboard и bootstrap
├── scripts/               сборка, упаковка, acceptance, cleanup
├── tests/                 unit/regression, fixtures и native workerd kernel
├── docs/                  карта, runbook, эксплуатация, исторические аудиты
└── .private/              ignored конфигурация установки / credentials / отчёты
```

Корневые файлы: `package.json`, `bun.lock`, `tsconfig.json`, `README.md`, `LICENSE`, `.gitignore`, `.prettierignore`. Настройки Prettier — в `package.json`. Приложения заказчиков не являются workspace этого репозитория.

| Workspace                                      | Публикация              | Назначение                                                    |
| ---------------------------------------------- | ----------------------- | ------------------------------------------------------------- |
| `@auersperg/flare` (`packages/flare`)          | Публичный npm, MIT      | Единственная зависимость приложения: SDK и executable `flare` |
| `@flare/platform` (`packages/core`)            | `private: true`, не npm | Core Workers и platform services                              |
| `@flare/dashboard` (`packages/core/dashboard`) | `private: true`, не npm | Сборка онлайн-dashboard                                       |
| `flare-workspace` (root)                       | `private: true`         | Toolchain и общий lockfile                                    |

**Один устанавливаемый пакет не означает одну папку исходников.** Готовые Core/dashboard/bootstrap/migrations входят в `dist/platform` того же tarball, но не в browser SDK exports или application bundle. Dashboard использует `@auersperg/flare: workspace:*` для совместной разработки; внешние приложения используют опубликованный registry package, без локальных SDK/CLI overrides и symlinks.

Публичные exports: `@auersperg/flare` (client), `/server`, `/react`, `/protocol`, `/cloudflare`. React — optional peer `>=19`. SDK JavaScript portable; CLI требует Bun. Весь репозиторий MIT, не только SDK.

## 4. Стек и сборка

Зафиксированные версии из текущих manifests, не обещание «всегда latest»:

| Инструмент                 | Версия / роль                                                     |
| -------------------------- | ----------------------------------------------------------------- |
| Bun                        | `1.4.3`, package manager / CLI / compiler / tests                 |
| Node                       | CI `24`; vendor Wrangler boundary, не runtime приложения          |
| Wrangler                   | `4.149.0`                                                         |
| Cloudflare Workers types   | `5.20261010.1`                                                    |
| Workers compatibility date | `2026-10-10`; release validator требует эту дату                  |
| Agents                     | `0.28.0`, только публичные Lifecycle/WebSockets/Scheduler modules |
| Astro / Astro React        | `7.3.8` / `7.0.1`                                                 |
| React / React DOM          | `19.3.0`                                                          |
| TypeScript                 | `6.0.2`                                                           |
| Tailwind                   | `4.3.3`                                                           |
| shadcn / Base UI           | `4.21.4` / `1.9.0`                                                |
| Zod / Standard Schema spec | `4.6.5` / `1.1.0`                                                 |

`bun run build` выполняет:

1. `scripts/build-packages.mjs`: Bun.Transpiler → portable SDK ESM; TypeScript → declarations; Bun.build → lazy/split CLI для Bun. Проверка не допускает core/agents/wrangler/workerd внутрь CLI bundle.
2. `scripts/build-platform.mjs`: Astro static dashboard → `packages/core/dist/dashboard`; CSP hashes из HTML; Bun bundles → `admin.js` и `runtime.js`; compilation пустого bootstrap приложения; bootstrap artifacts в assets для внутреннего provisioning.
3. Проверки metafile исключают полный MCP слой из core bundles. Worker bundles target Cloudflare/browser ESM с external `cloudflare:workers` / `node:*`, а не Bun runtime.

Astro сохраняет свой Vite pipeline. Wrangler используется с поддерживаемым Node runtime: попытка принудительно запускать vendor dev tooling под Bun ранее зависала. `nodejs_compat` в Cloudflare даёт совместимые API, а не запускает Node-сервер.

Version в Runtime `/health`, Admin `/api/session` и CLI help берётся из соответствующего package manifest; равенство workspace versions проверяется тестами. Admin stage — `trusted-team-preview`, не production-сертификация. Изменения working tree не означают новый npm release или cloud deployment.

## 5. Control plane

**Admin Worker** управляет проектами, окружениями, настройками, credentials, релизными операциями и dashboard API `/api/*`.

D1 хранит customer/project/environment metadata, membership, hashes deploy credentials, CLI login sessions, audit, alias reservations, deletion fences и lease административного cleanup. **D1 не хранит документы приложения, пользовательские пароли приложения или основной runtime release journal** — они находятся в соответствующих DO/facet.

Admin → Runtime: нативный service binding `RUNTIME`, entrypoint `RuntimeControl`. Runtime → Admin: `ADMIN_API`, entrypoint `AdminControl`; это gateway для `/control/api/*`, не публичный доступ к Cloudflare account API.

Project create создаёт dev/prod, origin settings, immutable alias mapping и пустой bootstrap. Новому проекту не добавляются demo tables/functions/users. Проектное удаление — отдельная owner-only операция, описанная ниже.

Административные изменения оборачиваются аудитом с actor, project/environment, operation, time, status и ограниченным detail. Транзакция D1 не является общей транзакцией с DO/R2: partial failure/retry — явная операционная граница.

## 6. Data plane и Dynamic Workers

**Runtime Worker** принимает HTTP/WebSocket, определяет scope, проверяет rate/origin/identity и передаёт вызовы supervisor. Публичный base URL среды:

```text
https://api.flare.auer.wien/<alias>/dev
https://api.flare.auer.wien/<alias>/prod
# Неизменяемый UUID route также поддерживается:
https://api.flare.auer.wien/p/<project UUID>/prod
```

Alias → UUID хранится write-once в R2 `routes/<alias>.json`. Per-isolate positive cache ограничен 256 mappings; misses не кешируются; concurrent cold lookups дедуплицируются. Alias не переприсваивается другому проекту после удаления — старый URL не должен открыть чужие данные.

`EnvironmentSupervisor` — обычный SQLite-backed DurableObject, владеющий active/candidate release, password auth, subscription state, файловыми grants/metadata, jobs/receipts, расписаниями, recovery и backup/deletion fences.

`ctx.facets.get("app", ...)` запускает `AppFacet` из Dynamic Worker. **Facet имеет собственную SQLite, отделённую от supervisor**; app-код не получает supervisor storage или общие account bindings. Эта изоляция соответствует [нативной модели Facets](https://developers.cloudflare.com/dynamic-workers/usage/durable-object-facets/).

Loader использует:

```text
LOADER.get(scope + hash + abi4 + policyHash + compatibilityDate + role)
role = facet | action
```

Request ID и пользовательский token не участвуют в ID. Код читается из R2, SHA-256 сверяется с manifest. Role-specific limits: CPU 1000 ms; facet subrequests 0; action subrequests 100. Активный metadata cache bounded: до четырёх releases / 4 MiB.

Facet egress запрещён (`globalOutbound: null`). Actions работают отдельно, без прямой SQLite; получают узкий `AppCapability`. Outbound по умолчанию запрещён, разрешается operator policy только на exact HTTPS hosts, без implicit redirects/TCP; поток ограничен 1 MiB, deadline 10 секунд. Секреты выдаются только по scoped mapping в Secrets Store bindings, не как account API token. Provisioning и облачная приёмка optional capabilities остаются отдельными задачами.

## 7. Данные и схема

ORM/Drizzle и legacy SQL migration API удалены. Документный DX — небольшой собственный слой поверх **нативного `storage.sql` SQLite**.

```ts
import { defineSchema, defineTable, z } from "@auersperg/flare/server";
export default defineSchema({
  tasks: defineTable(
    z.object({
      title: z.string(),
      done: z.boolean().default(false),
    }),
  ).index("by_done", ["done"]),
});
```

Каждая логическая таблица — физическая SQLite table с `_id`, `_creationTime`, `_data` (validated JSON). Scalar indexes — SQLite expression indexes на JSON fields, не JS filtering всей коллекции. Идентификаторы проверяются/quoted, values bind-ятся; raw SQL клиентам и `ctx.db` не выдаётся.

API: `get(table,id)`, `query(table).withIndex(...).order(...).take/first/paginate`; mutation дополнительно `insert`, `patch`, `replace`, `delete`. Страницы 1–100, keyset cursor привязан к форме запроса; до 1000 database operations на вызов. Read capability отзывается после invocation, незавершённые writes учитываются до commit.

Schema activation валидирует существующие документы и применяет индексы транзакционно. Невалидные данные/несовместимый контракт отклоняют активацию; удаление непустой таблицы не является автоматической миграцией данных. Transformations выполняются явными application mutations. Код rollback не откатывает документы.

Системные таблицы `_flared_*` содержат revision/table changes/outbox/schema metadata и скрыты от обычного Data UI. Prefix сохранён как внутренний storage identifier, не публичное имя продукта. Поддерживается только ABI 4; совместимость со старыми SQL/Drizzle ABI 1–3 не обещается.

## 8. Функции и контекст

**Только три server kinds: query, mutation, action. Отдельного kind `live` нет.** Для каждой функции обязательны input/output validators с JSON Schema converters; auth default — `required`.

| Kind     | Контекст                                                    | Семантика                                                                            |
| -------- | ----------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| query    | `ctx.db` read-only, `ctx.auth`                              | Snapshot или подписка на ту же функцию; без writes/egress                            |
| mutation | `ctx.db` writable, `ctx.auth`, `ctx.jobs.schedule/cancel`   | Native transaction; data/revision/outbox вместе; invalid output откатывает изменения |
| action   | `ctx.auth`, `runQuery/runMutation`, files/schedules/secrets | Нет прямого SQLite; внешние эффекты не входят в DB transaction                       |

`auth: public|required|internal` — входная проверка, **не автоматический row-level ACL**. Приложение проверяет ownership/permissions через `ctx.auth.subject`, а не доверяет присланному user ID. `internal` недоступен прямому public client call.

Mutation flow:

```text
Supervisor: durable recovery job/marker до вызова
  → Facet: validate input → native transaction
       handler + pending DB writes + validate output + revision + outbox
  → commit/sync
  → Supervisor: dispatch due outbox + recalculate affected subscriptions
  → ответ mutation
```

В текущем runtime mutation ждёт recovery/broadcast до ответа. Дальнейшая оптимизация этого пути требует сохранения crash correctness, а не простого fire-and-forget.

## 9. Реактивность

Supervisor использует публичные модули `agents/lifecycle`, `agents/websockets`, `agents/schedules`; физические sockets/alarm принадлежат supervisor, не facet. Нативные RPC пересылают сериализуемые invocation/results, не родительский WebSocket.

```text
client.onUpdate(query,args)
  → HTTP single-use short-lived ticket
  → shared hibernating WebSocket
  → subscribe frame → initial query snapshot
  → mutations commit → affected query snapshots → ACK
```

Первый результат приходит той же подпиской: дополнительный initial HTTP query не нужен. Ticket request — connection authentication, не второй query. One-off `client.query()` остаётся HTTP.

Реализация отслеживает **table-level dependencies**, не полный Convex read-set/index-range engine. Query должна зависеть от DB/args/auth: clock/random virtualization и отдельной инвалидации от времени нет. При mutation пересчитываются затронутые active queries; новая code release инвалидирует зависимости. В пределах broadcast одинаковые path/args/auth дедуплицируются, неизменившийся результат не отправляется. Auth входит в key, разные identities не смешиваются. Snapshot cache bounded: 64 entries / 4 MiB.

Persisted subscription state и connection attachments переживают hibernation. ACK ограничивает отправки медленному клиенту: промежуточные изменения объединяются до актуального snapshot, нет бесконечного backlog. Reconnect повторно подписывается и получает текущее состояние, не гарантированный replay всех промежуточных событий. Expired/revoked auth прекращает выдачу данных. Без subscribers query не выполняется в фоне.

Cloudflare поддерживает сохранение соединений при idle hibernation; это не обещание нулевой стоимости активных вызовов или хранения. [Hibernation WebSockets](https://developers.cloudflare.com/durable-objects/best-practices/websockets/).

## 10. Dashboard

Единственный dashboard — онлайн, Cloudflare Static Assets + Admin Worker + Access. Локального dashboard/SSR server/administrative callback server нет.

UI: Astro static shell, React island, Tailwind CSS variables, shadcn Base Lyra/Stone/Geist/Lucide (`components.json`). UI primitives находятся в `components/ui`, общие typed forms/status/function badges — shared components. Data grid использует shadcn Table, а не перенесённый Convex grid или собственный внешний сервер таблиц.

Header: project selector, Development/Production tabs. Sidebar: **Health, Data, Schema, Functions, Files, Schedules, Auth, Logs**. Settings — gear; SDK setup — из Health. Вторичные views lazy-loaded; root session/projects fetch параллелен, старые запросы отменяются при смене view/scope.

| Раздел    | Реальная работа                                                                                                                                   |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| Health    | Supervisor status, active hash, connections/subscriptions; последние пять backend releases выбранной среды; contract details и release operations |
| Data      | Pagination, typed insert/edit/delete, expectedRevision конфликт, validators, audit, подтверждение prod; таблица занимает рабочую область          |
| Schema    | Contract активного release; Add/Edit table готовит draft для application code, не изменяет облачную схему напрямую                                |
| Functions | Manifest, цветные query/mutation/action badges, typed arguments/results; ручной запуск только dev, не viewer/internal                             |
| Files     | Scoped R2 list, upload/download/delete через grants; pagination и cleanup состояния                                                               |
| Schedules | Outbox/job state, попытки/receipts, UTC cron; не универсальная stream pub/sub консоль                                                             |
| Auth      | User list/settings по read permissions; create/reset/block/revoke/configure только owner через Access; hashes/passwords не возвращаются           |
| Logs      | Recent bounded invocation summaries; не весь Cloudflare Workers Logs dataset и не billing                                                         |
| Settings  | Origin/OIDC, credentials, backups, owner-only deletion проекта                                                                                    |

**Реактивные приложения ≠ полностью push-reactive dashboard.** Admin views сейчас snapshots: read при открытии, после собственного изменения, при focus/visibility return; compact reload предусмотрен там, где нужен. Interval polling нет. Изменения другого SDK-клиента не инвалидируют все открытые Data/Auth/Files views автоматически: отдельный Access-authorized dashboard push channel ещё не реализован.

Static asset routing: `run_worker_first: ["/*", "!/_astro/*"]`. HTML/API проходит Admin auth/membership и security headers; hashed `/_astro/*` обслуживается native assets route с immutable caching. Bootstrap artifacts запрещены в публичном Admin fetch. Astro CSP hashes включаются в core build; `connect-src` ограничен dashboard/runtime; HTML `no-store`, no-referrer/nosniff. Edge Access policy должна защищать hostname независимо от asset routing.

## 11. Три независимые границы авторизации

### 11.1 Администратор dashboard

Cloudflare Access → проверенная identity → D1 membership owner/editor/viewer. Где доступен native `ctx.access`, проверяется AUD; для asset-router boundary fallback криптографически проверяет Access assertion/cookie через issuer/audience/JWKS. Доверия к произвольному email header нет. Mutating browser requests требуют same-origin.

Viewer читает; editor имеет разрешённые write/deploy операции; owner управляет пользователями/auth, удаляет проект и выполняет owner operations. Project-scoped CLI credential не получает права изменять app-users/auth settings даже от owner. Read endpoints Auth сейчас доступны по общим read permissions: это не owner-only просмотр списка пользователей.

### 11.2 Разработчик / CI приложения

Browser CLI approval через защищённый dashboard, matching code, выбранный/новый проект. Ten-minute login request, ephemeral RSA-encrypted credential delivery, one-time claim. CLI credential живёт 30 дней и хранится вне приложения в `~/.config/flare`, mode 0600; D1 хранит hash, scope, expiry/revocation. Settings может отозвать его. CI использует `FLARE_DEPLOY_TOKEN` из своего secret store, не из frontend env.

### 11.3 Пользователь приложения

Два механизма: встроенный password auth выбранной среды или явно настроенный JWT/OIDC (signature, issuer, audience, JWKS, expiry). Access login оператора не является пользовательским входом приложения.

Password auth находится в supervisor SQLite: нормализованный login, salted scrypt hash (`N=16384,r=8,p=5`, random 16-byte salt, 32-byte key), opaque random session token; в базе hash session token. Текущая политика пароля **6–128 символов**, срок сессии **12 часов**, persistent per-login rate limit. Это описание текущей политики, не утверждение, что короткие пароли достаточны для всех production-сценариев.

Registration по умолчанию закрыта; owner включает её отдельно для dev/prod. Регистрация не создаёт platform administrator. Owner reset/block/revoke удаляет соответствующие sessions и отключает affected live clients. Hashes не возвращаются Auth API; исключение — приватная backup capsule.

`createPasswordAuth()` сохраняет браузерную сессию в localStorage, namespace по URL среды; `restore()` проверяет `/v1/auth/me` до protected UI. Network error не считается доказательством invalid session; cross-tab storage events синхронизируются. Сервер/mobile задаёт storage явно или memory-only. Это не HttpOnly-cookie auth: приложение должно учитывать XSS-риск хранения bearer token. Dispose не равен logout. Автоматического вечного refresh, MFA, email recovery и OAuth sign-in UI нет.

**Пароль, изменённый в dev, не меняется в prod.** Одинаковый login в двух средах не связывает их учётные записи.

## 12. SDK и протокол

`createClient({url,getToken})` работает в browser/server JS; transport можно адаптировать без обязательного `window`. Публичные методы: `query`, `mutation`, `action`, `onUpdate`, `refreshAuth`, `dispose`. React: `FlareProvider`, `useFlare`, `useQuery`; provider использует client приложения, не создаёт свой.

`useQuery` возвращает data/`undefined` при загрузке или `"skip"`, автоматически unsubscribes; errors передаются error boundary. SSR не открывает sockets/polling. При обычном reconnect сохраняется последний snapshot до нового; отказ авторизации, в том числе при получении нового ticket, очищает live cache.

| Endpoint относительно base URL среды                       | Назначение                         |
| ---------------------------------------------------------- | ---------------------------------- |
| `POST /v1/call`                                            | Function path/kind/args, HTTP JSON |
| `POST /v1/live/ticket`                                     | Короткоживущий single-use ticket   |
| `GET /v1/live?ticket=…`                                    | WebSocket upgrade                  |
| `POST /v1/auth/{register,login,logout,me,change-password}` | Password auth                      |
| `POST /v1/files/upload?ticket=…`                           | Single-use upload grant            |
| `GET /v1/files/download?ticket=…`                          | Download grant до expiry           |

Отдельного Convex-style HTTP Actions hostname нет: actions вызываются через тот же `/v1/call`. Произвольный application HTTP/webhook router в текущем SDK не предоставлен.

JSON lossless: нет implicit Date/undefined/NaN/class coercion. Limits из `protocol.ts`: input 64 KiB, output 256 KiB, client frame 8 KiB, subscriptions 64/connection, files 10 MiB. Manifest максимум 200 functions; facet/action code максимум 1 MiB каждый. Core/Dynamic CPU limit сейчас 1000 ms — не общий рекламируемый максимум тарифа.

Mutation не повторяется автоматически при network failure; неоднозначный write result отмечается `ambiguous`. Upload grants тоже не retry-ятся автоматически. Клиент должен проверить состояние перед повтором.

Внутренние `_flared_*`, `flared_session_`, `flaredSession`, `x-flared-identity`, `flared:session:` сохранены для storage/wire continuity и retained releases. Это не дополнительные legacy packages или alias kind `live`.

## 13. CLI и developer flow

npm registry проверен 12.10.2026: `next = 0.3.2`, `latest = 0.3.1`. Для воспроизводимого flow ниже exact version, не случайный dist-tag:

```sh
bun add @auersperg/flare@0.3.2
bunx --bun --package @auersperg/flare@0.3.2 flare dev
```

1. Первый `dev` scaffold-ит минимальный `flare/` и предлагает platform URL, если приложение ещё не linked.
2. Browser approval выбирает/создаёт проект. Публичное connection state — `.flare/project.json`; deploy secret — только user config вне проекта.
3. `flare/schema.ts` — default `defineSchema`; named query/mutation/action exports — `flare/*.ts`, nested directories дают nested paths; underscore helpers не регистрируются как функции.
4. CLI обнаруживает modules, формирует typed `_generated/server.ts`, компилирует facet/action; генерирует manifest/schema/release/checksums, browser-safe API references и OpenAPI 3.1.
5. Публикует cloud dev, генерирует `flare/_generated/{api,references}.ts`. Backend-код не импортируется в browser.
6. Записывает публичный dev URL в `.env.local`, сохраняя остальные variables: Astro `PUBLIC_FLARE_URL`, Expo `EXPO_PUBLIC_FLARE_URL`, иначе `VITE_FLARE_URL`.
7. Backend watch ограничен source backend, сериализует builds/дедуплицирует неизменившийся hash; не деплоит backend от каждого frontend edit. Frontend запускается своей `bun run dev` командой отдельно.

```sh
# Собрать текущий backend и подтвердить prod deployment:
bunx --bun --package @auersperg/flare@0.3.2 flare deploy
# Посмотреть проверенные dev releases:
bunx --bun --package @auersperg/flare@0.3.2 flare releases --env dev
# Активировать конкретную проверенную dev сборку в prod:
bunx --bun --package @auersperg/flare@0.3.2 flare promote --env prod --hash HASH
```

Advanced commands: `build`, `link`, `deploy --release`, `rollback`, `backup create|list|restore|delete|status`. Установка платформы отделена: `platform install|status|update`; legacy `platform init` отсутствует. `db generate` отсутствует и не нужен document API. Local workerd используется только acceptance tests ядра, не installed developer backend.

## 14. Релизы и frontend

App release — immutable facet/action code + manifest + document schema + checksums; identity SHA-256. Сборка происходит до пользовательских запросов. Core deployment и app release — разные события: замена core не переписывает retained app bundles, SDK update в `package.json` не меняет облачный backend без app deploy.

Activation выполняется через serial gate. При active actions/running jobs возвращает `CONFLICT`, а не обещает уже реализованный бесконечный graceful drain. Проверяет ожидаемый current hash, совместимость схемы, cron/job contracts. Candidate записывается долговечно; постоянный facet `app` перезапускается через `abort()`, **не delete**. После schema readiness active/candidate/history фиксируются; recovery продолжает interrupted activation. Это не единая транзакция между supervisor DB и facet DB.

В Health показываются последние пять distinct successful backend hashes выбранной среды. Promote переносит exact dev code bundle в prod **без dev данных, users, files или config**. Rollback применяет retained совместимый code bundle, не data rewind. Исторического изолированного preview каждой версии нет.

```sh
bunx --bun --package @auersperg/flare@0.3.2 flare promote \
  --env prod --hash HASH --cmd "bun run build"
# После успеха — native hosting deploy, например в приложении:
bunx --no-install wrangler deploy
```

Каждый CLI deploy проверяет expected active hash, не только flow с `--cmd`; `CONFLICT` не retry-ится автоматически. Невалидный environment или неподтверждённый prod deploy останавливается до scaffold/evaluation application code.

`--cmd` генерирует контракт нужной backend версии и запускает frontend build с целевым URL в child environment (`FLARE_URL`, `PUBLIC_FLARE_URL`, `VITE_FLARE_URL`, `NEXT_PUBLIC_FLARE_URL`, `EXPO_PUBLIC_FLARE_URL`) **до backend activation**. Dev `.env.local` не переписывается. При failed build backend не активируется, предыдущие generated `api.ts`/`references.ts` восстанавливаются. Network/не-JSON ошибки management API сохраняют HTTP status, если он известен; неоднозначный write требует проверки состояния, а не автоматического повтора.

Frontend hosting deploy — отдельный следующий шаг application script/CI; Flare CLI не публикует frontend автоматически. Если он упал после backend activation, получился partial release. **Полный frontend/backend deploy последовательный, не атомарный**, без paired history/automatic paired rollback. Старые браузеры/mobile clients требуют backward-compatible contracts даже после успешного promote.

## 15. Файлы

Bytes — private R2 `FILES`; metadata/state/grants — supervisor. Ключи ограничены scope и immutable file ID; raw shared R2 binding приложению не выдаётся.

Actions: `ctx.files.upload/download/generateUploadUrl/getDownloadUrl/list/delete`. Browser upload получает grant через разрешённую функцию приложения, затем streaming POST в Runtime. Upload grant одноразовый; download grant reusable до expiry, пять минут. URL — bearer capability: не логировать/публиковать как обычную ссылку. File ownership проверяется application function до выдачи grant.

Предел 10 MiB, declared exact size + FixedLengthStream; bytes не буферизуются целиком. MIME allowlist: plain text, PNG/JPEG/WebP, PDF, binary; остальные browser formats отправляются binary с исходным именем. Ready metadata подтверждается после успешной R2 записи; failures/expired uploads cleanup-ятся через долговечные recovery jobs. Это не антивирус и не межсервисная SQL+R2 транзакция.

Dashboard upload использует тот же механизм, `DASHBOARD_URL` разрешает точный origin панели для grants. Pagination default 50/max 100, не чтение всех объектов на каждое открытие.

## 16. Задания и расписания

`ctx.jobs.schedule()` в mutation записывает outbox в той же transaction, что documents. `dueAt` хранится долговечно; supervisor alarm/Lifecycle будит среду по необходимости, не опрашивает каждую секунду.

Due outbox → `JOBS.sendBatch` → после подтверждения enqueue удаление sent outbox → native Queue push consumer → action конкретного retained release. Producer соблюдает count/byte bounds. Consumer обрабатывает до четырёх сообщений одновременно, ack/retry каждого отдельно.

Установка: batch size 10, max batch timeout 1 second, max concurrency 4, max retries 3, отдельная DLQ. Receipts помогают bounded deduplication, но внешние эффекты **at-least-once**, не exactly-once. [Гарантии Cloudflare Queues](https://developers.cloudflare.com/queues/reference/delivery-guarantees/).

Cron — `ctx.schedules.set/cancel/list` в action, публичный Agents Scheduler, UTC, persistent конфигурация supervisor. Callback создаёт job для action, не исполняет произвольный код внутри собственного cron parser. Нативный push Queue consumer отличается от dashboard snapshot refresh.

Schedules — наблюдение ограниченного состояния jobs/cron, не строгий proof физически пустой DLQ. Автоматического DLQ redrive нет: восстановление требует разбора неизвестных внешних эффектов и явной reconciliation.

## 17. Backup и удаление

### Backup

Settings/CLI создаёт on-demand logical capsule в private R2 BUNDLES: exact app release, documents с IDs, ready file copies и salted password hashes/users. Manifest фиксируется последним, содержимое проверяется checksum. Это credential-sensitive backup, не публичный export.

Bounds: 10 000 documents / 4 MiB logical data; до 100 files / 100 MiB file bytes. Не копируются active sessions, secrets, target origin/auth settings, cron и исторические jobs. Перед risky maintenance нужно pause/drain jobs/actions/uploads.

Restore — owner-confirmed, только в **другую пустую среду того же проекта**, с durable fence/checkpoints; failed restore остаётся fenced для retry. Не in-place overwrite, не PITR, не off-account disaster recovery. Auth target включается/настраивается явно. Periodic backup daemon не включён. [Runbook](production-runbook.md#backup-and-restore).

### Удаление проекта

Owner через Access подтверждает UUID и exact name; удаляются **dev и prod**. Сначала durable catalog fence и credential revocation, затем fences обеих сред, затем scoped DO/facet/R2 cleanup и D1 finalization. Partial failure сохраняет состояние для повторного удаления. Alias reservations, audit и небольшие deletion tombstones намеренно остаются; общий namespace/queues/Access policy и другие проекты не удаляются.

## 18. CI и npm publishing

### 18.1 GitHub `ci.yml`

Triggers: push main, pull_request, workflow_dispatch. Ubuntu 24.04, timeout 15 minutes; `contents: read`, checkout без persistent credentials; Actions pinned SHA. Concurrency по workflow/ref, старый run отменяется. Node 24 для Wrangler, Bun 1.4.3.

```text
checkout → setup Node/Bun
  → bun install --frozen-lockfile --ignore-scripts
  → bun run verify
       build → type/astro checks → unit tests → format check
       → verify-build (bundles/CSP/bootstrap)
       → package-acceptance (real tarball, external disposable app)
  → bun run test:kernel (local native workerd)
  → bun audit --production --audit-level=high
  → git diff --exit-code
```

CI **не имеет Cloudflare credentials**, не создаёт cloud resources, не деплоит core/customer apps и не публикует npm. Native kernel — локальная проверка, не облачная production certification. `git diff` ловит изменения tracked source от verification; secrets/configs не выдаются pull requests.

### 18.2 GitHub `publish.yml`

Отдельный manual workflow_dispatch, только `auersperg/flare`, ref main. Inputs: exact version из package manifest и dist-tag `next|latest`; environment `npm` (в текущей настройке репозитория — approval gate). Timeout 20 minutes, publishing concurrency сериализован и не cancel-ится новым run.

Workflow проверяет имя/version/license MIT/private flag, повторяет verify/kernel/audit/clean diff, затем `bun pm pack --ignore-scripts` **только packages/flare**. Устанавливает pinned npm `12.1.0`; публикует tarball через `npm publish --access public --tag ... --provenance`.

Publish job имеет `id-token: write`; npm Trusted Publisher связан с repo → `publish.yml` → environment `npm`. Постоянный npm publish token workflow не использует. Это [OIDC trusted publishing](https://docs.npmjs.com/trusted-publishers/), не авторизация Cloudflare.

Зафиксированный срез registry от 12.10.2026: публичный `@auersperg/flare@0.3.2` под `next`, `latest = 0.3.1`. Dist-tags изменяемы: перед установкой проверять registry или использовать exact version. Доступность exact версии 0.3.4 с platform payload проверять отдельно в registry. Working-tree изменения не включаются задним числом в опубликованный immutable package; для их публикации нужна новая version. Core/dashboard приватны только в смысле npm publication; их исходники публичны и MIT.

### 18.3 CI клиентского приложения

Это pipeline отдельного application repository/Cloudflare Builds, **не `ci.yml` платформы**:

```text
install exact registry SDK → app checks
  → Flare CLI deploy/promote с scoped FLARE_DEPLOY_TOKEN и --confirm UUID
  → frontend build для target URL (через --cmd)
  → native frontend hosting deploy
  → inspect endpoint / login / query / subscription
```

Фактический порядок с `--cmd`: build выполняется внутри deploy/promote до activation; hosting — после. GitHub необязателен для local CLI release, но полезен для source review/CI/npm publishing. Cloudflare Builds token и Flare deploy credential — разные credentials, один не заменяет другой. Наличие core CI не означает, что все application Build integrations настроены/проверены.

## 19. Эксплуатация и экономия

### Установка и обновление core

Новый managed lifecycle: `flare platform install|status|update` — [команды, state и recovery](platform-lifecycle.md). CLI использует проверенный payload своей версии, D1 installation ID/journal/revision lease и сохраняет namespace/resource IDs. `--dry-run` делает только чтения; destructive/legacy/undeclared upgrades запрещены. Сам installer не выполняет cloud acceptance или автоматические обновления.

Ниже сохранён прежний ручной operator flow для существующей, **не автоматически adopted**, установки:

Рабочие конфигурации находятся в ignored `.private/cloudflare/{admin,runtime,landing}.wrangler.json`; отслеживаемые examples в `packages/core` содержат placeholders, а не deploy-ready credentials.

Для новой установки оператор создаёт D1/R2/Queues/DLQ, SQLite DO exports/namespace и Loader binding, применяет административные migrations, добавляет owner membership, signing secret, custom domains и Access application/policy. Admin/Runtime имеют взаимные service bindings: первоначальное provisioning требует временного Runtime bootstrap без отсутствующего Admin binding, затем Admin и финального Runtime. Смена имени Worker не должна незаметно пересоздавать DO namespace и терять данные.

Для уже provisioned установки:

```sh
bun install --frozen-lockfile --ignore-scripts
bun run verify
bun run test:kernel
# Сначала отдельно применить необходимые D1 migrations, если они изменились.
bun run deploy:dashboard
# Только при изменениях Runtime; build уже выполнен предыдущей командой:
bunx --no-install wrangler deploy --config .private/cloudflare/runtime.wrangler.json
# Landing — отдельный optional static deployment:
bunx --no-install wrangler deploy --config .private/cloudflare/landing.wrangler.json
```

Эти команды явно изменяют облако и не являются частью обычного CI. `deploy:dashboard` не обновляет Runtime автоматически и не применяет D1 migrations. `bun run clean` удаляет только локальный reproducible output/reports/caches, не credentials, source, installed dependencies или cloud data; после него нужен новый build. Cloud acceptance использует отдельные disposable scopes и не должна направляться на данные заказчика.

### Ресурсы при работе и простое

Нет постоянно работающей VM, dashboard interval polling, автоматического backup timer или synthetic heartbeat. Auth/job/catalog cleanup идёт bounded on-traffic; alarms планируются для реальных delayed jobs, auth expiry, file recovery и cron. Созданный DO и открытый hibernating socket не означают непрерывное выполнение CPU; idle storage всё равно занимает квоту.

Retention: job receipts 30 дней; catalog audit 90 дней; expired deploy credentials 14 дней grace; bounded cleanup до 1000 rows/category. Старые releases eligible после 30 дней, но последние пять successful, active/candidate и job/outbox references защищены. Static hashes кешируются; данные и credentials не public-cache-ятся.

У core включены Workers Logs head sampling 100%; traces выключены. Native `DynamicTail` собирает bounded exceptions/console dynamic code, затем Workers Logs. Dashboard summaries: successful queries до 100 in-memory, исчезают при restart/hibernation; mutation/action/errors durable bounded history (до 200 persisted, UI максимум 100). Это экономит SQL writes успешных reads, но **не полный исторический журнал**.

Analytics Engine/Analytics SQL bindings в текущей конфигурации нет. Нет собственного usage collector, always-on logging service или verified alert configuration. Error/billing данные читаются через native Cloudflare interfaces с необходимыми правами.

Считать отдельно: Workers request/CPU, Dynamic daily-unique creations/startup CPU, DO request/duration/SQLite, D1 rows, R2 storage/operations, Queues operations, Logs и builds. Нельзя сложить разные requests в единую квоту или назвать `$5` cap. Стабильный loader ID предотвращает создание Dynamic Worker на каждый запрос, но тот же ID/code заново учитывается в новый день по [Dynamic Workers pricing](https://developers.cloudflare.com/dynamic-workers/pricing/).

Ночная read-only проверка 12.10 не обнаружила непрерывного DO расхода в тихом окне. Полный historical Workers Logs и Billing недоступны текущему operator OAuth: точный invoice и причины всех старых exceptions не подтверждены. Частный отчёт остаётся в `.private/audits`; числа тестового workload не являются гарантией месячной стоимости.

## 20. Проверки и оставшиеся границы

### Что проверяет repository tooling

Unit/regression: database/schema/runtime semantics, transaction rollback, capabilities, client/React subscriptions и auth rejection при reconnect, password/session persistence, file grants/streaming, jobs/queues, auth/origin/routing, backups, retention/deletion, dashboard presentation, packaging/cleanup, согласованность версий и локальных documentation links.

Local native kernel: настоящее workerd/Lifecycle/facet RPC/SQLite/hibernation/recovery; fault injection есть только в test harness, не production bundles. Package acceptance устанавливает tarball вне workspace без symlink и компилирует отдельное ephemeral frontend приложение. Cloud acceptance scripts явные, создают disposable scopes и обязаны подтверждать cleanup; они не запускаются обычным `verify`.

### Не выдаём за завершённые возможности

- `platform install|status|update` реализованы в исходниках 0.3.4 и покрыты mock/package/local-native gates. На временной установке в существующем account владельца прошли реальный install, recovery после потери ответа финального deploy, native-data canary через packaged CLI/SDK, same-version no-op update, discovery без локального cache и scoped cleanup с совпадением исходного/итогового инвентаря. Отдельный реальный upgrade 0.3.3 → 0.3.4 подтвердил сохранность native-data, app release, DO namespace и resource identities, Access policy, старого developer JWT, password session, приватного файла и pending job. Вход владельца через настоящий Access проверен в браузере отдельно. Независимый account/full-scope-token platform CLI ещё не подтверждён. Legacy operator adoption и автоматическое reconciliation конфигурации не реализованы. Подробнее: [platform lifecycle](platform-lifecycle.md).
- Полное graceful release draining и все concurrent crash cases: открытая приёмка; serial gate/conflict и recovery checkpoints не равны полной гарантии.
- Access-authorized cross-client push dashboard invalidation: отсутствует.
- Доступ к полным historical logs/billing/alerts: в текущем audit неполный.
- External OIDC provider acceptance и optional Secrets Store/egress provisioning: отдельные cloud gates.
- Customer-specific dashboard delegation, untrusted public code marketplace, automatic sharding, cross-project transactions: отсутствуют.
- Automatic DLQ redrive, PITR, off-account disaster recovery, paired frontend/backend history/atomic rollout: отсутствуют.
- 30-minute soak отменён по просьбе владельца; нельзя называть его пройденным. Для реальной нагрузки нужна отдельная проверка latency/throughput/cost.

Dynamic Workers/Facets и используемые Agents modules опираются на beta/экспериментальные API. Версии зафиксированы, но обновление Cloudflare API может потребовать повторной native/cloud проверки. Успешные локальные tests или short cloud proofs не дают SLA и не доказывают отсутствие всех vulnerabilities.

Приоритеты дальнейшей доработки и проверяемые критерии готовности — в [production gates](maintenance.md#remaining-production-gates). Они не считаются реализованными этой очисткой репозитория.

## 21. Навигация по исходникам

| Ответственность                                | Основные файлы                                                                                   |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| Admin API / permissions / audit                | `packages/core/src/admin.ts`, `security.ts`, `cli-login.ts`                                      |
| Supervisor / loader / activation / service RPC | `packages/core/src/runtime.ts`                                                                   |
| Native document DB / schema / app runtime      | `packages/flare/src/sdk/database.ts`, `schema.ts`, `cloudflare.ts`                               |
| Function definitions / contexts                | `packages/flare/src/sdk/server.ts`                                                               |
| Transport / auth persistence / React           | `packages/flare/src/sdk/client.ts`, `react.ts`, `protocol.ts`                                    |
| Reactive invalidation/cache                    | `packages/core/src/reactivity.ts`                                                                |
| Password auth                                  | `packages/core/src/auth.ts`                                                                      |
| Release integrity / aliases                    | `packages/core/src/release.ts`, `routing.ts`                                                     |
| Optional egress / secret capabilities          | `packages/core/src/capabilities.ts`                                                              |
| Files / Queue delivery                         | `packages/core/src/files.ts`, `queue.ts`                                                         |
| Backups / deletion / retention                 | `packages/core/src/backups.ts`, `project-deletion.ts`, `maintenance.ts`, `retention.ts`          |
| Function summaries                             | `packages/core/src/observability.ts`                                                             |
| CLI entry / cloud operations / build           | `packages/flare/src/cli/main.mjs`, `cloud.mjs`, `build.mjs`, `bundle.mjs`                        |
| CLI discovery / login                          | `packages/flare/src/cli/project.mjs`, `login.mjs`                                                |
| UI / data fetch lifecycle                      | `packages/core/dashboard/src/components/dashboard.tsx`, `common.tsx`, `lib/model.ts`             |
| Build / acceptance                             | `scripts/build-packages.mjs`, `build-platform.mjs`, `verify-build.mjs`, `package-acceptance.mjs` |
| Pipeline contracts                             | `.github/workflows/ci.yml`, `publish.yml`                                                        |

[Cloudflare product catalogue](cloudflare-capability-map.md) — датированный справочник вариантов, не перечень подключённых bindings. [Краткое сопоставление](flare-architecture-map.md) — индекс этой карты. [Runbook](production-runbook.md) — обслуживание, [maintenance](maintenance.md) — инварианты и приоритеты production-доработки, [packaging](packaging.md) — дистрибуция. Устаревший отдельный audit удалён; сырые отчёты не подменяют текущий код, конфигурации и результаты проверки выбранного release.

## 22. K2 — расширение, не текущий компонент

**На момент фиксации K2 в Flare не подключён:** нет K2 binding/streams, `ctx.events`, client event subscription или cloud acceptance. Обсуждение добавления не считается реализацией.

K2 public beta доступен на Workers Paid и даёт durable event log с независимыми subscriptions. Чтение сейчас pull/consume+batch ACK, at-least-once; нативные push Worker consumers в roadmap. Это отдельная роль от jobs Queue и мгновенных database subscriptions. [K2 docs](https://developers.cloudflare.com/k2/), [consume](https://developers.cloudflare.com/k2/features/consume/), [анонс](https://blog.cloudflare.com/cloudflare-k2-streams/).

Предлагаемая, **ещё не реализованная** граница: transactional event outbox → native K2 publish → независимые серверные subscriptions, scope isolation и event-ID idempotency. Не заменять текущие queries/WebSockets или Queues; не создавать постоянный polling каждого browser. Consumer wake-up/latency/cost и доступ K2 API нужно определить/проверить перед подключением. Во время beta K2 billing выключен; Worker execution не становится бесплатным. [Pricing](https://developers.cloudflare.com/k2/platform/pricing/).
