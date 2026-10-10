# Flared — единая архитектура Cloudflare-native платформы

Дата решения: 10 октября 2026 года. **Статус: утверждённая целевая модель; развёрнут private minimum, не весь public MVP.**

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

Работающий интерфейс: Health, Data, Schema, Functions, Files, Schedules, Logs; выбор проекта/среды в шапке, Settings под шестерёнкой, SDK под Health. Files, Secrets, cron UI и полные analytics не имитируются. Новые проекты после установки обновлённого Admin получают пустой bootstrap, без демонстрационных таблиц/функций; существующие релизы и данные не сбрасываются. Data edits проходят mutation/commit/live и аудит; разрушительные prod-операции требуют подтверждения. Схема и функции меняются через код, миграции и релизы. Произвольный SQL, создание/drop таблиц мышкой и компиляция в браузере не входят в MVP.

## 3. Облачные компоненты

| Компонент                            | Назначение                                                                       |
| ------------------------------------ | -------------------------------------------------------------------------------- |
| Admin Worker + Static Assets         | Онлайн-dashboard, роли, каталог и релизы                                         |
| Runtime Worker                       | API приложений, loader, actions, Queues consumer                                 |
| D1                                   | Каталог заказчиков/проектов/сред/релизов и аудит; не app DB                      |
| Supervisor DO на project/environment | Активный релиз, физические WebSockets, auth-aware подписки, расписания, recovery |
| Постоянный facet `app`               | Изолированная SQLite, Drizzle, query/live/mutation                               |
| Dynamic Worker action-role           | Actions без прямого доступа к app SQLite                                         |
| R2                                   | Неизменяемые сборки, файлы, экспорты                                             |
| Queues + Scheduler                   | Outbox, отложенные задания, повторная доставка и DLQ                             |
| Tail / Workers Logs / Analytics      | Ошибки и метрики; доступность datasets проверяется                               |
| Secrets Store                        | Серверные секреты среды, write-only управление                                   |

Два основных Worker общие для проектов, **не два Worker на каждого заказчика**. Frontend сайтов размещается независимо; статическому лендингу не обязательно использовать backend SDK.

Основа — Dynamic Workers + native Durable Object Facets. Beta/экспериментальные API фиксируются по версиям и проверяются в настоящем Cloudflare. Нет скрытого fallback к обычным Worker на проект. Supervisor использует публичные Lifecycle/WebSockets/Scheduler, не полный Agent, AI/MCP или приватные SDK методы. WebSocket/alarm принадлежат supervisor; между ним и facet — сериализуемый native RPC.

## 4. Выполнение, релизы и безопасность

- Сборка происходит в CLI/CI. R2 содержит код, manifest, миграции и SHA-256.
- Loader ID стабилен для project/environment + build hash + config version + compatibility date + runtime role; request ID и access token в него не входят.
- D1/dashboard не находятся в пути каждого вызова приложения. Активное состояние среды хранится в supervisor.
- Имя facet остаётся `app`. Обновление через `abort()`, не удаление данных. Prepare/drain/migrate/activate и recovery требуют долговечного журнала. Rollback кода не является rollback базы.
- Query/live read-only; mutation фиксирует данные, revision, validated output и outbox транзакционно. Live отправляется после commit. Внешние эффекты — в action.
- Native SQLite не разрешает `PRAGMA query_only`: SDK использует отдельную single-SELECT capability и native transaction. Ограничение документировано, не выдано за SQLite GA-функцию.
- Перед mutation supervisor долговечно планирует recovery. Generic SDK outbox связан с native Queues consumer/recovery и проверен фактической delivery receipt.
- Queues — at-least-once: deduplication, retry/DLQ и идемпотентность внешних эффектов обязательны. Старые сборки сохраняются, пока на них ссылаются задания.
- Data-role не имеет egress; actions получают scoped capabilities; outbound пока запрещён, контролируемый внешний HTTP ещё не реализован. Общие D1/R2 bindings и account token не передаются приложениям.
- API приложений: HTTP JSON; live: hibernating WebSocket, короткоживущий single-use ticket, ACK/coalescing/reconnect snapshot. JWT/OIDC signature/issuer/audience/JWKS/expiry и origin allowlist обязательны для production.
- Авторизация администратора отделена от авторизации пользователей приложений. Deploy credentials не попадают в frontend env: публичным является URL среды, не административный токен.
- Первый MVP предназначен для доверенных разработчиков оператора, не для публичного исполнения чужого непроверенного кода.

## 5. Пакеты и тонкий локальный flow

| Пакет              | Граница                                                                               |
| ------------------ | ------------------------------------------------------------------------------------- |
| `@flared/sdk`      | Объявления функций, browser/server JS client, React hooks, build-time native adapters |
| `@flared/cli`      | Сборка, link/watch/deploy; без dashboard, Agents, Wrangler/workerd зависимости        |
| `@flared/platform` | Облачный core и онлайн-dashboard; не frontend dependency                              |

Исполняемый файл — `flared`. Это локальные tarballs, не опубликованные пакеты. Scope не означает подтверждённого владения npm namespace. License пока UNLICENSED; open source требует явно выбранной лицензии и независимой установки в другом аккаунте.

**Реализованные команды:**

```sh
flared build --entry app.ts --migrations drizzle --outdir release
flared link --platform <runtime-url>/control --project <project-id>
flared dev --entry app.ts --migrations drizzle
flared deploy --env dev --release release
```

Генерируются facet/action bundles, contract/migrations/checksums, standalone `api.ts` и OpenAPI 3.1. Браузер не импортирует backend-код. CLI — build-time инструмент, не постоянный backend сервис.

**Целевой flow — пока не реализован целиком:**

1. `flared platform init` — идемпотентная установка в выбранный аккаунт, Access, dashboard URL.
2. Создание пространства/проекта в онлайн-dashboard.
3. `flared link --platform <runtime-url>/control --project <id>` — привязка локального кода.
4. `flared db generate` — генерация проверяемых миграций.
5. `flared dev` — watch backend и публикация в cloud dev. Frontend запускается обычным dev server приложения. Нет локальной базы Flared или dashboard.
6. `flared deploy --env prod --release <directory> --confirm <project-id>` — проверенная публикация, без переустановки core.

Работают build/link/dev/deploy; platform init и db generate отвергаются, а не имитируют успех. Нового локального dashboard режима не будет. Локальный workerd в acceptance scripts — внутренний тест ядра, не продуктовый developer flow и не зависимость установленного CLI.

Авторизация dashboard использует нативный `ctx.access`, проверяет AUD конкретного Access приложения и получает platform-verified identity. JWT/OIDC приложений — отдельная граница. Новая установка имеет два Worker `flared-admin`/`flared-runtime`; не используются ресурсы старого kernel. Панель не делает background polling; static assets сейчас проходят Admin Worker для access/headers, поэтому такие посещения учитываются в Worker requests.

## 6. Совместимость и оставшаяся приёмка

Legacy SDK/CLI и обе демонстрации убраны из рабочего репозитория; восстановимые копии находятся вне него. В production build входит только пустой bootstrap. Минимальные тестовые приложения остаются в tests и не используются как production seed. Имена уже созданных Cloudflare Worker/DO/R2/Queues, существующий SQL prefix `_reactive_` и путь репозитория не переименовываются без отдельной миграции. Они не являются публичными названиями Flared.

Локальный kernel имеет тестовую конфигурацию без account ID; конфигурация существующей облачной приёмки хранится отдельно и не коммитится. В Git входят только шаблоны Admin/Runtime, а рабочие конфигурации остаются у оператора. Перед open source нужны независимая установка, лицензия и подтверждение registry scope.

Обязательны: расследование зарегистрированного WebSocket timeout, повторные hibernation/recovery проверки, независимый production OIDC provider, полное draining/crash recovery релизов, файлы/Secrets Store, реальные dashboard datasets, clean install → два проекта → dev/prod → frontend → upgrade, экспорт/restore и нагрузка 1 000 записей / 100 live клиентов / 30 минут. Latency/cost нового runtime не выводятся из коротких kernel проверок.

Цены и лимиты сверяются с фактическим workload и актуальной документацией, не фиксируются как вечное обещание $5 за весь сервис. Основные ссылки: [Dynamic Workers / Facets](https://developers.cloudflare.com/dynamic-workers/usage/durable-object-facets/), [Static Assets](https://developers.cloudflare.com/workers/static-assets/billing-and-limitations/), [Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/).
