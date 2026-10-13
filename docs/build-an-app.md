# Создание приложения на Flare — руководство для агента

Проверенная база: **`@auersperg/flare@0.3.9`**, Bun **1.4.3+**. Это trusted-team preview, не обещание полного Convex parity или SLA. Не выбирайте автоматически `latest`: он может указывать на другую версию. При обновлении SDK сначала проверяйте совместимость с установленной платформой.

Это инструкция для **отдельного приложения**, а не для изменения Flare. Полная реализация — в [архитектуре](architecture.md); установка самой платформы — в [platform lifecycle](platform-lifecycle.md); эксплуатационные ограничения — в [runbook](production-runbook.md).

## 1. Модель и границы

```text
Репозиторий приложения                 Уже установленная платформа Cloudflare
  flare/schema.ts + функции -- CLI --> immutable release, cloud dev / prod
  frontend -- HTTP / WebSocket ------> Runtime Worker
                                         │ project + environment
                                         ▼
                                      Supervisor Durable Object
                                         │ active release
                                         ▼
                                      app facet: SQLite + query/mutation
                                      action runtime: внешние эффекты

Владелец -- Cloudflare Access --> dashboard / Admin Worker --> D1 catalogue
Платформа: R2 releases/private files, Queues jobs, native secrets/capabilities.
Frontend hosting — отдельно. Dashboard не находится в пути запросов приложения.
```

- **Query:** чтение базы; один вызов или живая подписка на ту же функцию.
- **Mutation:** транзакционная запись; уведомления подписчиков и jobs outbox обслуживает платформа.
- **Action:** внешние эффекты, файлы и вызовы разрешённых query/mutation. Не одна транзакция с внешним сервисом.
- Данные приложения живут в SQLite facet конкретного project/environment, **не в D1 catalogue**. `dev` и `prod` изолированы.
- CLI login разрешает деплой проекта. App login определяет пользователя приложения. Cloudflare Access защищает администрирование. Это **три разные границы**, не взаимозаменяемые токены.

Для обычного приложения не нужны собственные Worker, Durable Object, D1, Queue, R2 bucket, Wrangler config, ORM или SQL migrations. Не добавляйте их «на будущее». Нативную инфраструктуру и capabilities настраивает оператор платформы, только при реальной необходимости.

## 2. Структура приложения

```text
my-app/
├── AGENTS.md                 # скопированный и заполненный шаблон
├── package.json / bun.lock   # точные зависимости и один lockfile
├── src/                     # frontend выбранного framework
├── tests/                   # проверки приложения
└── flare/
    ├── schema.ts            # default export defineSchema
    ├── tasks.ts             # named exports query/mutation/action
    ├── _model.ts            # helper; underscore исключает discovery
    └── _generated/          # server.ts, api.ts, references.ts — создаёт CLI
```

Вложенные файлы создают вложенные пути функций: `flare/billing/invoices.ts` → `api.billing.invoices.*`. Helpers размещайте в `_*.ts` / `_*/`; не экспортируйте случайно server functions из общих файлов. Не пишите вручную `defineApp`, generated API, Worker entrypoint или платформенный manifest в обычном flow.

Коммитьте код, тесты, `AGENTS.md`, `package.json`, lockfile. Не коммитьте `.flare/`, `flare/_generated/`, `.env.local`, credentials, release/build output. CLI добавляет основные ignore-правила; проверьте также `node_modules/` и output вашего framework. Публичные имена env можно описать в `.env.example` без секретов.

## 3. Первый запуск

В отдельном frontend-проекте с `package.json`:

```sh
bun add --exact @auersperg/flare@0.3.9
bunx --bun --package @auersperg/flare@0.3.9 flare dev
```

1. Укажите **Runtime URL установленной платформы**, полученный от владельца. Это не project dev URL и не адрес dashboard.
2. Подтвердите код в защищённом dashboard и выберите/создайте проект. Человек проходит Access; агент не ищет его cookies или коды в чужих файлах.
3. CLI сохранит scoped credential вне приложения в `~/.config/flare` (0600, срок 30 дней). `.flare/project.json` — локальная привязка, не frontend credential. После истечения/отзыва нужно новое подтверждение.
4. CLI создаст пустой `flare/schema.ts`, если его нет; существующие файлы не перезаписывает. Добавьте код из следующего раздела; watch соберёт и отправит backend в **реальную облачную dev-среду** и создаст `_generated`.
5. Запустите frontend отдельной командой вашего framework. CLI пишет публичный dev URL в `.env.local`: Astro `PUBLIC_FLARE_URL`, Expo `EXPO_PUBLIC_FLARE_URL`, обычный Vite `VITE_FLARE_URL`. Для другого framework явно настройте его публичную env-переменную; не угадывайте prefix.
6. В dashboard для выбранной среды задайте разрешённые frontend origins (точный scheme/host/port), auth и нужные capabilities. Без этого frontend не считается настроенным.

`flare dev` — не локальный emulator и не preview production данных. Записи/расходы в Cloudflare настоящие; используйте только согласованный проект. Frontend edits не деплоят backend. Cloudflare account API token обычному приложению **не нужен**.

## 4. Минимальный backend с изоляцией пользователей

Это пример приватных задач, не публичный demo seed. Для выполнения функций нужен app-user token. Владелец настраивает auth отдельно для dev/prod; registration по умолчанию закрыта. Не открывайте регистрацию только ради проверки.

```ts
// flare/_model.ts
import { z } from "@auersperg/flare/server";
import { FlareError, type Auth } from "@auersperg/flare/protocol";

export const taskFields = z.object({
  owner: z.string().min(1),
  title: z.string().trim().min(1).max(200),
  done: z.boolean().default(false),
});
export const taskDocument = taskFields.extend({
  _id: z.string(),
  _creationTime: z.number(),
});
export function subject(auth: Auth | null): string {
  if (!auth) throw new FlareError("UNAUTHORIZED", "Sign in required");
  return auth.subject;
}
```

```ts
// flare/schema.ts
import { defineSchema, defineTable } from "@auersperg/flare/server";
import { taskFields } from "./_model";

export default defineSchema({
  tasks: defineTable(taskFields).index("by_owner", ["owner"]),
});
```

```ts
// flare/tasks.ts
import { z } from "@auersperg/flare/server";
import { FlareError } from "@auersperg/flare/protocol";
import { query, mutation } from "./_generated/server";
import { subject, taskDocument } from "./_model";

export const list = query({
  auth: "required",
  input: z.object({
    limit: z.number().int().min(1).max(50).default(20),
    cursor: z.string().nullable().optional(),
  }),
  output: z.object({
    page: z.array(taskDocument),
    continueCursor: z.string().nullable(),
    isDone: z.boolean(),
  }),
  handler: ({ db, auth }, args) =>
    db
      .query("tasks")
      .withIndex("by_owner", (q) => q.eq("owner", subject(auth)))
      .order("desc")
      .paginate({ limit: args.limit, cursor: args.cursor }),
});

export const create = mutation({
  auth: "required",
  input: z.object({ title: z.string().trim().min(1).max(200) }),
  output: z.string(),
  handler: ({ db, auth }, args) =>
    db.insert("tasks", { owner: subject(auth), title: args.title }),
});

export const setDone = mutation({
  auth: "required",
  input: z.object({ id: z.string().min(1), done: z.boolean() }),
  output: z.null(),
  handler: async ({ db, auth }, args) => {
    const owner = subject(auth);
    const task = await db.get("tasks", args.id);
    if (!task || task.owner !== owner)
      throw new FlareError("FORBIDDEN", "Task is unavailable");
    await db.patch("tasks", args.id, { done: args.done });
    return null;
  },
});
```

`auth: "required"` — также default, но явно показан здесь. Он **не заменяет record ownership**. Источник владельца — `ctx.auth.subject`, не `args.owner`, email или frontend state. Для patch/delete сначала прочитайте запись и проверьте доступ. Одинаковая ошибка для отсутствующей и чужой записи не раскрывает наличие чужого объекта. Shared/team access требует отдельной явной модели membership и её тестов.

CLI компилирует app source локально; top-level код модулей не должен делать сетевые запросы, читать секреты или запускать side effects.

## 5. Frontend и realtime

Ниже framework-neutral browser module; вызовите `connectFlare` один раз из browser lifecycle, передав **project environment URL из `.env.local`**. Не создавайте общий SSR singleton для пользователей. После `restore` покажите login UI, если `auth.getUser()` пуст; login/password приходят из формы, не из env/исходников.

```ts
// src/flare-client.ts
import { createClient, createPasswordAuth } from "@auersperg/flare";

export async function connectFlare(url: string) {
  const auth = createPasswordAuth({ url });
  const client = createClient({ url, getToken: auth.getToken });
  const stopAuth = auth.onChange(() => client.refreshAuth());
  const dispose = () => {
    stopAuth();
    client.dispose();
    auth.dispose();
  };
  try {
    await auth.restore();
    return { auth, client, dispose };
  } catch (error) {
    dispose();
    throw error; // Покажите retry UI, не трактуйте network error как logout.
  }
}
```

Владелец компонента/страницы останавливает подписки и вызывает `dispose()` при teardown. `await auth.logout()` отзывает session; `dispose()` **не logout**. Browser auth использует bearer token в localStorage, не HttpOnly cookie: защита от XSS обязательна. Для server/mobile задайте явное storage или `storage: null`. Email recovery/MFA не реализованы; не обещайте их в UI.

```tsx
// src/Tasks.tsx
import { useQuery } from "@auersperg/flare/react";
import { api } from "../flare/_generated/api";

export function Tasks({ signedIn }: { signedIn: boolean }) {
  const result = useQuery(api.tasks.list, signedIn ? { limit: 20 } : "skip");
  if (!signedIn) return <p>Войдите в приложение.</p>;
  if (!result) return <p>Загрузка…</p>;
  return (
    <ul>
      {result.page.map((task) => (
        <li key={task._id}>{task.title}</li>
      ))}
    </ul>
  );
}
```

Родитель оборачивает UI в `<FlareProvider client={client}>`, обновляет `signedIn` через `auth.onChange`, обрабатывает ошибки ErrorBoundary и сам управляет cleanup. Компонент выше показывает только первую страницу; для следующей передайте `continueCursor`, пока `isDone === false`. Проверяйте pagination отдельно.

Без React используйте `client.onUpdate(api.tasks.list, { limit: 20 }, render, onError)`; он возвращает unsubscribe и доставляет initial snapshot. **Не делайте initial `query` перед подпиской и не добавляйте interval polling.** Для разового чтения используйте `client.query`. Для записи — `await client.mutation(api.tasks.create, { title })`. Генерированные browser references не импортируют handlers/schema; frontend не должен импортировать `@auersperg/flare/server` или backend modules.

## 6. Правила реализации без лишних слоёв

| Решение          | Правило                                                                                                                                                                                                                                      |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Данные           | Один schema contract, валидированные input/output; JSON, не Date/undefined. Ограничивайте размер строк, массивов и страниц. Индекс под реальный запрос, не full scan + JS filter.                                                            |
| Schema evolution | Сначала additive optional/defaulted поля. Активация проверяет существующие документы транзакционно; несовместимое изменение отклоняется. Преобразование данных — явная app mutation, не ручной SQL. Code rollback не восстанавливает данные. |
| Side effects     | Query без эффектов, mutation без внешнего `fetch`; внешний сервис — action. Await обязательных операций. Secrets только серверные; оператор разрешает secret bindings/внешние hosts. Не предполагайте unrestricted egress.                   |
| Jobs             | Только если действительно нужна фоновая работа. Mutation → `await ctx.jobs.schedule(...)`; at-least-once, обработчик с idempotency key у внешнего получателя. Никаких fire-and-forget/слепых повторов неоднозначных записей.                 |
| Files            | Private storage и короткие scoped grants; streaming для bytes. App проверяет ownership file ID: scope проекта не означает ownership пользователя. Logout не отменяет уже выданный download grant до TTL.                                     |
| Auth             | Public функции только для явно публичных данных; internal не для browser. Проверяйте ownership/membership на сервере во всех путях чтения/изменения.                                                                                         |
| Realtime         | Один client на browser lifecycle, live query вместо polling; unsubscribe/cleanup. Reconnect и смена пользователя не должны показывать чужие cached records.                                                                                  |
| Структура        | Сначала прямые handlers/components. Не добавляйте repository/service/event-bus layers, K2, отдельный auth server, cron backups или второй CLI без конкретного требования.                                                                    |
| Зависимости      | Pin SDK и lockfile; поддерживаемый framework, одна система сборки. Не обновляйте платформу/SDK «заодно».                                                                                                                                     |

Это Flare API, не Convex API: не выдумывайте `ctx.auth.getUserIdentity`, `ctx.storage`, `v`, `useMutation`, `db.insert(value)` без имени таблицы. Проверяйте экспортируемые types установленной версии. Общие [Cloudflare Workers best practices](https://developers.cloudflare.com/workers/best-practices/workers-best-practices/) полезны оператору, но не требуют добавлять Wrangler в каждое приложение.

## 7. Production delivery

После dev acceptance и **явного подтверждения владельца**:

```sh
bunx --bun --package @auersperg/flare@0.3.9 flare deploy --cmd "bun run build"
```

Команда собирает backend, генерирует API, запускает frontend build с URL целевой **prod** среды, затем активирует backend с подтверждением проекта. Подставьте реальную build-команду вашего framework. Ошибка build не должна активировать backend. `.env.local` продолжает указывать на dev. Обычный `flare deploy` без `--cmd` тоже поддерживается, но frontend build/target URL тогда обеспечьте отдельно.

Для продвижения уже проверенного immutable dev release:

```sh
bunx --bun --package @auersperg/flare@0.3.9 flare releases --env dev
bunx --bun --package @auersperg/flare@0.3.9 flare promote --hash <verified-dev-release-hash> --cmd "bun run build"
```

Frontend output публикуется **отдельным hosting flow**. Backend activation и frontend deployment не являются общей atomic transaction: используйте совместимые additive API изменения и проверяйте обе стороны. Перед prod проверьте prod auth, origins, capabilities и восстановление согласно требованиям проекта; не копируйте dev пользователей/данные автоматически.

CI использует scoped `FLARE_DEPLOY_TOKEN`, корректную project link и явный `--confirm <project UUID>`; секрет хранится в CI secret storage, не frontend env. `flare platform install/adopt/update`, прямой Wrangler deploy платформы, Access/DNS/account-token изменения — работа оператора, не обычный app release.

## 8. Definition of done

- [ ] SDK pinned, lockfile сохранён; нет secrets/generated/build output в Git.
- [ ] Backend собирается CLI, frontend проходит typecheck/build и тесты приложения.
- [ ] Проверены anonymous denied, invalid input, две разные учётные записи; B не читает/меняет задачи A. Public endpoints отдельно обоснованы.
- [ ] Создание/изменение видны второму client того же пользователя без polling; проверены reconnect/logout/смена пользователя и cleanup.
- [ ] Pagination, empty/error/loading состояния проверены, нет безлимитных чтений.
- [ ] Dev URL не попал в prod frontend; dev/prod данные и настройки не смешаны.
- [ ] Внешние эффекты/файлы/jobs, если есть, проверены на права, retries/idempotency и лимиты; не добавлены без надобности.
- [ ] Prod deployment/hosting разрешены владельцем; проверен UI после доставки, не только exit code команды.
- [ ] В отчёте разделены локальные тесты и реальные cloud проверки; неизвестное не названо PASS.

Тестирование cross-user/reconnect — задача конкретного приложения. Компиляция примеров этого документа не заменяет его cloud acceptance.

## 9. Что передать следующему агенту

Скопируйте [шаблон AGENTS.md](templates/AGENTS.md) в **корень приложения**, заполните публичные metadata/команды. Это не root-инструкция для репозитория Flare. При необходимости положите это руководство в `docs/flare-build-an-app.md` приложения; обновляйте его осознанно вместе с SDK, не поддерживайте вторую копию архитектуры платформы.

Готовый запрос:

```text
Создай [описание приложения] на Flare в этом отдельном репозитории.
Сначала прочитай AGENTS.md и руководство по указанной там версии SDK.
Используй существующий framework, native Flare schema/query/mutation/action,
генерированные API и realtime subscriptions. Начни с минимального вертикального
среза, явно задай модель прав, проверь её на двух пользователях.
Работай только с согласованным cloud dev проектом; production и platform
изменения не выполняй без отдельного подтверждения. Не запрашивай account token.
Сдай код, тесты, инструкции запуска и отчёт с фактически проверенными результатами.
```
