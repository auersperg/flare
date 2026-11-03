# Flare: платформенные пробелы для Memory

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Добавить адресный поиск по metadata и устранить потерю параллельных patch без включения Memory в runtime.

**Architecture:** Существующие SQLite, AI Search, SDK и mutation runtime. Фильтры — нативное подмножество Cloudflare: равенство и `$in`, с обязательной partition и локальной проверкой metadata.

**Tech Stack:** TypeScript, Bun tests, SQLite, Cloudflare AI Search.

**Spec:** `/Users/adam/Documents/Work/Projects/development/flare/docs/unified-memory-core.md`, раздел «Достаточность платформы Flare».

## Global Constraints

- Без новых зависимостей, баз, посредников и прикладной модели кейсов.
- Старые вызовы SDK сохраняют поведение; миграции данных для этих исправлений не нужны.
- Не деплоить, не переносить память, не изменять OAuth/облачную конфигурацию.
- Сохранить обязательные ACL/version callbacks и server-selected partition.

## Review Focus

- Provider игнорирует metadata: чужая выборке запись не возвращается.
- Зарезервированный folder/операторы/слишком длинные UTF-8 значения: INVALID_INPUT до provider.
- Обновление/удаление во время ACL callback: устаревшая версия не возвращается.
- Параллельные patch разных полей одной записи: оба изменения сохраняются.
- Ошибки async validation и завершение capability: нет поздней записи или скрытого частичного успеха.

## Task 1: Metadata filters

Files: `packages/flare/src/sdk/search.ts`, `packages/flare/src/sdk/server.ts`, `packages/core/src/search.ts`, `tests/search.test.ts`, `docs/build-an-app.md`.

Interface: exported `SearchRecordFilters = Record<string, string | { $in: string[] }>`; optional `filters` in `SearchRecords.query`. Up to five non-reserved lowercase keys; strings at most 64 UTF-8 bytes; `$in` has 1..20 strings. Multiple keys are AND. Empty filters object rejected; omit it for unfiltered search.

- [x] Add failing tests for native equality/$in forwarding, local filtering when provider ignores it, invalid shapes, and update during authorization.
- [x] Run `bun test tests/search.test.ts` and observe missing-filter failure.
- [x] Add bounded validation, forward filters alongside fixed folder, recheck persisted metadata before returning candidates. Keep source ACL/version checks unchanged.
- [x] Run targeted search tests and TypeScript check; document instance metadata schema prerequisite and SDK example.

## Task 2: Concurrent database patches

Files: `packages/flare/src/sdk/database.ts`, `tests/native-database.test.ts`.

Interface: unchanged `db.patch(table,id,partial)`; concurrent disjoint patches cannot overwrite one another inside the same invocation.

- [x] Reproduce lost update using Promise.all and an asynchronous validator.
- [x] Apply minimal per-invocation write consistency fix, preserving validators and capability lifetime.
- [x] Run `bun test tests/native-database.test.ts`, covering rejection/deletion/revocation where affected.

## Finish

- [x] Review changed runtime/SDK and tests independently; fix concrete findings.
- [x] Format only changed files. Run related SDK/search/database tests and type-check affected workspace.
- [x] Report verified local results separately from cloud/deployment, which remain untested here.
