# Flare — краткая карта реализации

Обновлено 12 октября 2026. **Полная актуальная карта: [architecture.md](architecture.md).** Этот файл — короткий индекс, а не вторая независимая спецификация. Источник истины для поведения — код и конфигурации; старые acceptance checkpoints не заменяют текущую проверку.

| Область              | Нативная основа                                 | Текущая реализация                                                                 |
| -------------------- | ----------------------------------------------- | ---------------------------------------------------------------------------------- |
| Online dashboard     | Workers Static Assets + Cloudflare Access       | Astro/React/shadcn; 8 sidebar sections; snapshots без interval polling             |
| Control plane        | Admin Worker, D1, service bindings              | Каталог/membership/audit/CLI credentials; не DB приложения                         |
| App API              | Runtime Worker + native RPC                     | HTTP JSON, origin/rate/auth checks; D1 отсутствует в обычном data path             |
| Isolation            | SQLite Supervisor DO + Durable Object Facet     | Immutable project/environment scope; постоянный facet `app` со своей SQLite        |
| Code execution       | Dynamic Workers Loader                          | Стабильный ID по scope/hash/ABI/policy/date/role; facet/action separation          |
| Documents            | Native SQLite JSON + expression indexes         | Validators, read/write capabilities, keyset pagination; без Drizzle                |
| Functions            | Facet/WorkerEntrypoint                          | Query/mutation/action; query может быть snapshot или reactive subscription         |
| Live                 | Hibernating WebSocket + Lifecycle               | Initial snapshot, table dependencies, auth-aware dedup, ACK/coalescing/recovery    |
| Auth                 | Access / scoped credentials / supervisor SQLite | Три независимые identity boundaries; password auth и optional OIDC                 |
| Files                | R2 + streaming/RPC                              | Private scoped keys, temporary grants, 10 MiB limit                                |
| Jobs/cron            | Queues/DLQ + Scheduler/alarms                   | Transactional outbox, at-least-once actions, delayed/UTC cron                      |
| Releases             | R2 + supervisor activation journal              | Last five hashes, exact promote, compatible code rollback; не DB rollback          |
| Backup/delete        | R2 + DO/D1 fences                               | Bounded logical capsules, empty other environment restore, owner-only deletion     |
| Secrets/egress       | Secrets Store + restricted globalOutbound       | Optional scoped implementation; operator provisioning/cloud gates открыты          |
| Logs                 | Dynamic Tail + Workers Logs                     | UI summaries bounded, не full telemetry/billing; Analytics SQL binding отсутствует |
| SDK/CLI distribution | Bun + npm registry                              | Один `@auersperg/flare`; core/dashboard npm-private workspaces                     |
| CI/release           | GitHub Actions + npm OIDC                       | Read-only CI без cloud deploy; manual approved npm publishing                      |
| K2 streams           | Cloudflare K2                                   | Обсуждено, **не подключено**; не текущая часть runtime                             |

Нативные сервисы не предоставляют автоматически document validators, auth-aware reactive query invalidation, transactional outbox, release recovery и scoped grants. Этот небольшой слой — ответственность Flare, а не скрытый ORM/broker/полный перенос Convex backend.

## Документы

- [Полная архитектура, dashboard, packages, CI и developer flow](architecture.md)
- [Каталог возможностей Cloudflare и альтернатив](cloudflare-capability-map.md)
- [Production operations и recovery](production-runbook.md)
- [Maintenance и приоритеты production-доработки](maintenance.md)
- [Упаковка SDK/CLI](packaging.md)

Конфигурации действующей установки и сырые отчёты находятся в ignored `.private`, не в публичной карте. Ночная Analytics проверка не закрыла полный historical Logs/Billing доступ, поэтому точный счёт и все причины старых exceptions остаются непроверенными.
