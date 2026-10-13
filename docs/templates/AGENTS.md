# AGENTS.md — приложение на Flare

Это шаблон для **отдельного приложения**, не инструкция по разработке платформы Flare. Перед использованием заполните поля ниже; неизвестные значения уточните у владельца, не выдумывайте IDs/адреса. Не записывайте сюда секреты.

## Контекст проекта

- Назначение приложения: **заполнить**.
- Frontend framework и версия: **заполнить по package.json**.
- SDK: `@auersperg/flare@0.3.9` (проверенная база; изменение версии требует проверки совместимости).
- Runtime URL установленной платформы: **заполнить публичный URL**.
- Dashboard URL: **заполнить публичный URL**.
- Project UUID: **заполнить после browser approval**; не чужой пример UUID.
- Рабочая среда: `dev`. Разрешённый cloud scope: **указать согласованный проект и действия**.
- Модель доступа: **private per-user / team membership / намеренно public — описать**.
- Команды frontend dev / typecheck / test / build: **заполнить реально существующие scripts**.
- Hosting flow: **заполнить; отдельный от backend activation**.

## Сначала прочитать

1. Этот файл, `package.json`, lockfile, текущие `flare/schema.ts` и server functions.
2. [Руководство для создания приложения](https://github.com/auersperg/flare/blob/main/docs/build-an-app.md). Если сохранена локальная копия `docs/flare-build-an-app.md`, сначала читайте её и сверяйте версию.
3. При вопросах об устройстве платформы: [архитектура](https://github.com/auersperg/flare/blob/main/docs/architecture.md); не переносите её internal interfaces в приложение. Main docs могут быть новее pinned SDK; API подтверждайте types установленной версии.

## Архитектура приложения

- Frontend → portable Flare client → Runtime → project/environment Supervisor → SQLite app facet. D1 — только административный catalogue, не app database.
- `flare/schema.ts` — `defineSchema` / `defineTable` / Zod contract и нужные индексы.
- `flare/*.ts` — named query/mutation/action; helpers `_*.ts` / `_*/` исключены из discovery.
- `flare/_generated/server` — schema-typed query/mutation/action wrappers; `flare/_generated/api` — browser-safe references.
- Не редактируйте generated файлы. Не импортируйте server declarations/handlers/schema в frontend.
- Нормальному приложению не нужны собственные Worker/DO/D1/Queue/R2/Wrangler/ORM. Не добавляйте инфраструктуру, compatibility aliases, repository layers, event bus или демонстрационные данные без требования.

## Flow

```sh
bun add --exact @auersperg/flare@0.3.9
bunx --bun --package @auersperg/flare@0.3.9 flare dev
```

Bun 1.4.3+. Перед install проверьте существующие dependencies, не переписывайте lockfile без необходимости. CLI owner approval проходит через Access-protected dashboard; scoped credential хранится вне приложения. `flare dev` собирает/генерирует и пишет в **реальный cloud dev**, это не emulator. Frontend запускается отдельно своей согласованной командой. Runtime URL для CLI и project environment URL для client — разные адреса; используйте выданный `.env.local` и framework-правильный prefix.

## Правила безопасности и качества

- CLI deployment login ≠ app-user login ≠ Cloudflare Access owner login.
- `auth: "required"` default; public только при явной необходимости. Internal функции не browser API.
- Record ownership/membership проверяется server-side во всех read/write путях. Для per-user модели используйте `ctx.auth.subject`, никогда `args.owner` как источник прав. Для patch/delete проверьте запись до изменения.
- Валидируйте input/output, ограничивайте строки/массивы/страницы. Индексы и `.paginate`, не full collection + JS filter.
- Query читает; mutation транзакционно пишет; внешние эффекты — action. Await обязательных операций, никаких side effects при import модулей.
- Jobs добавляйте только при необходимости; at-least-once требует idempotency. Не повторяйте автоматически write с неизвестным результатом.
- Private files: проверка ownership ID, scoped short-lived grants, streaming. Project scope не равен per-user permission.
- Один client на browser lifecycle; `useQuery` / `onUpdate` вместо polling и отдельного initial fetch. Cleanup подписок/client/auth; никаких user-session SSR singletons.
- Восстановите auth до protected UI; loading/error/anonymous — разные состояния. `logout()` отзывает session, `dispose()` только cleanup. Bearer localStorage требует XSS защиты; не обещайте несуществующие email recovery/MFA.
- Секреты только server-side через согласованные capabilities; не читайте operator credentials и не включайте tokens в env frontend, logs, Git, документацию.
- Git игнорирует `.flare/`, `flare/_generated/`, `.env.local`, build output, dependencies. Сохраняйте source/tests/lockfile.
- Schema changes сначала additive optional/defaulted; явные data transformations. Code rollback не database restore.

## Границы изменений

Работайте только внутри согласованного app scope. Не устанавливайте/обновляйте платформу, не изменяйте Access/DNS/Cloudflare resources, не удаляйте данные/backup, не публикуйте SDK. Account API token приложению не нужен. Не открывайте регистрацию ради теста. Production activation и frontend hosting выполняйте только после отдельного явного разрешения владельца.

После такого разрешения обычная команда backend+frontend build — `bunx --bun --package @auersperg/flare@0.3.9 flare deploy --cmd "bun run build"`, если `build` действительно существует. Frontend output доставляется отдельным hosting flow. Не считайте их одной atomic transaction; обеспечьте API compatibility. Не переносите dev env/данные/учётные записи в prod автоматически.

## Definition of done

- Typecheck/build/тесты и реальный dev vertical slice.
- Anonymous denied, invalid input, два пользователя и cross-user access denied.
- Realtime между двумя clients, reconnect/logout/смена пользователя, cleanup, pagination и error/loading UI.
- Нет secrets/server code в frontend, нет generated/build output в Git; prod URL/auth/origins проверены отдельно при разрешённой доставке.
- Отчёт: изменённые файлы, команды/результаты, фактический scope, непроверенные места. Не называйте локальную компиляцию облачной проверкой; не обещайте SLA по этому шаблону.
