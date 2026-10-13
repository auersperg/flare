# Flare 0.3.9 — доставка исправлений и личное обновление

13 октября 2026. Source commit: `c9b7ea8605b34a0ee207865c184fc92070a4445b`. Владелец подтвердил выпуск под `next` и обновление личной панели. **`@auersperg/flare@0.3.9` опубликован; панель обновлена с 0.3.8 штатным registry CLI. `latest` остаётся 0.3.1.**

## Доставлено

- Полная согласованная readiness-проверка: version, payload, installation identity, control-plane readiness, runtime ABI и protocol. `platform status` больше не принимает missing/wrong ABI/protocol за healthy.
- Безопасная диагностика update verification: последний HTTP status/availability и имена несовпавших полей; response bodies и credential values не печатаются. Resume без повторного deployment покрыт regression tests.
- Portable cloud backup/deletion harness: ignored workspace fixture вместо предположения о локальной `.private`, обычное разрешение dependencies, общая D1 statement validation, bounded read-only readiness, отсутствие автоматического replay POST, корректный FAIL/recovery evidence при cleanup failure.
- Проверка реального восстановленного password login в backup harness и точные требования Secrets Store Edit/secret Workers scope в руководстве.

Подробный разбор каждого пропуска — [follow-up 0.3.8](follow-up-after-0.3.8.md). Новые сервисы, Worker/Queue production-инфраструктуры, backup daemon или unattended updater не добавлялись.

## Release gates

| Проверка                                                                  | Результат                                                                                                   |
| ------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| Unit/regression                                                           | **416 pass, 0 fail**                                                                                        |
| Typecheck / Astro                                                         | 37 файлов, zero errors/warnings/hints                                                                       |
| Full verify / production build / CSP / portable tarball                   | PASS                                                                                                        |
| Native kernel / Runtime / D1 / facets / files / jobs / auth / restore     | PASS                                                                                                        |
| Native Secrets Store / physical dashboard sockets / membership revocation | PASS; не доказательство cloud Secrets Store permissions                                                     |
| Две независимые frozen builds                                             | Полные platform manifests побайтово совпали                                                                 |
| Production dependency audit                                               | 477 packages, известных уязвимостей не найдено                                                              |
| Disposable cloud 0.3.8 → 0.3.9                                            | PASS: data/app code/namespace/resources/Access/signing identity/password session/file/pending job preserved |
| Cloud features                                                            | PASS: managed config, native outbound, cross-client push/reconnect/revocation, backup freshness, discovery  |
| Cloud cleanup                                                             | PASS: полный account inventory равен baseline                                                               |
| Registry install                                                          | PASS: exact published archive, все 63 files, CLI help, portable Node SDK imports, tags                      |

[Source CI](https://github.com/auersperg/flare/actions/runs/38443738448) и [protected publication](https://github.com/auersperg/flare/actions/runs/38444340267) завершились success. Environment approval выполнен по явному подтверждению владельца; protections не отключались. Workflow опубликовал собственный exact accepted archive без repack.

- Published archive SHA-256: `5da5a0f972fd4ac6918a24ce4eb237b712bcf0e198fdaa7caaefd7c681684fce`.
- Platform digest: `a0d7181857f7b4ec5be28c139389cadac59b5d21a88a812f22ce424cdb605965`.

### Сохранённые несовпадения и неуспешные попытки

- Первый cloud fixture был прерван до завершения. Его run не PASS; scoped recovery удалил ресурсы и подтвердил полное равенство account baseline. Свежий полный run прошёл.
- Первый локальный архив имел другой container SHA (`756f8112…`): checkout/build запускались с private umask 077. Все **63 file contents идентичны** registry; tar header differences — только mode (0600/0711 вместо 0644/0755). Gate остановился, а не проигнорировал mismatch. После выставления стандартных package modes повторена полная portable package acceptance; новый локальный archive целиком совпал с registry/CI SHA. Code/payload bytes не переписывались, опубликованная версия не перепубликовывалась. Cloud transition использовал исходный archive с теми же 63 содержимыми.
- Первые private personal helpers не завершили baseline: route propagation 404 и ошибочный test-only вызов `settings` через RuntimeControl вместо catalog lookup. Оба удалены, update ещё не запускался, capsules не создавались. Скорректирован только private verifier: read-only propagation probes и catalog hash для config. Fresh helper завершил весь run. Это не исправление production Runtime и не скрытая повторная публикация.
- Exact version сначала возвращала registry 404 после успешного workflow. Дождались распространения; повторного publish не было.

## Личная установка

Target: `https://dash.flare.auer.wien`, Runtime `https://api.flare.auer.wien`. Installation identity и namespace сохранены; сторонние сайты/ресурсы не затронуты.

1. Созданы четыре complete pre-update capsules (два проекта × dev/prod), затем выполнен published-CLI dry-run и confirmed update 0.3.8 → 0.3.9.
2. Update завершился штатно, **personal resume не требовался**. D1 operation отсутствует.
3. Четыре complete post-update capsules сверены с pre-update: bundle/code, schema, documents/IDs/timestamps/revisions, private user hashes и file metadata/bytes hashes совпали. Независимые scoped live reads и catalog hash подтвердили data/auth/files/jobs/origin config и active code. Сырые records/secret values в отчёт не включены.
4. Access identity/policies, resource IDs, namespace и rate-limit identity совпали с исходными. Повторные dry-run и confirmed update — unchanged; Worker versions не поменялись от no-op. Live status — ready, с ABI/protocol checks нового CLI.
5. Владелец вошёл через настоящий Cloudflare Access. После reload: Health ready, `Live updates: connected`; Settings загрузился, Backups показывает newest-first и `within-24h`. Captured console warnings/errors — пусто. Никаких production record mutations для UI проверки не выполнялось.
6. Private proof Worker удалён, helper cleanup PASS; временный случайный key и scratch workspace удалены. Existing capsules и новые pre/post copies оставлены; platform token не расширялся.

Worker version IDs:

- Runtime: `16c32571-e770-4772-8051-c83b4e006062`.
- Admin: `76c174d7-78cc-4628-8cea-61d0b364d26e`.

Локальные ignored evidence: `artifacts/platform-039-cloud-acceptance.json`, `platform-039-registry-acceptance.json`, `platform-039-personal-update-acceptance.json`, `platform-039-ui-acceptance.json`; Health screenshot `artifacts/personal-panel-039-updated.jpg`. Private hashes/capsule IDs/diagnostics не коммитятся.

## Оставшиеся границы

Cloud Secrets Store binding через managed CLI ещё не принят: текущий CLI account token не имеет нужных прав. Возобновлённый Cloudflare connector выполнил только read-only stores list (200); это не доказательство Edit/binding/deploy и не повод расширять token молча. Native secret binding проверен.

Независимый аккаунт отсутствует; full graceful drain, off-account DR/PITR, consumer recovery, atomic frontend/backend rollout и общий load SLA не заявляются. Independent recovery на 111-document fixture прошёл на 0.3.8 в предыдущем проходе (~3.36 s); не выдаётся за повторный cloud restore всей 0.3.9 установки. Manual RPO 24h/RTO 1h остаётся operator objective, не автоматической гарантией.

**Итог:** подтверждённый выпуск и обновление завершены; три current guides синхронизированы. Рабочий trusted-team preview, без новой архитектурной сложности и без утверждения о закрытии всех production guarantees.
