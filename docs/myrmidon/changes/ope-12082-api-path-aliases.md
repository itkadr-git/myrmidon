---
divergence-section: Брендинг
---

## changelog-en

### Legacy API path alias /api/paperclip/* (1.7-RB-PATH)

- The pre-rebrand API surface `/api/paperclip/*` now resolves as a transparent
  alias of the canonical `/api/myrmidon/*` routes: a small middleware mounted
  first inside the `/api` router rewrites the complete path segment
  `/paperclip` to `/myrmidon` (`server/src/myrmidon/api-path-aliases.ts`).
- Same handlers, same contract, same status codes and headers — no redirect,
  so existing clients that still call `/api/paperclip/...` keep working for
  one release while the rebrand (roadmap-v1 §3.3, OPE-3540 item B4) lands.
- Paths such as `/api/paperclip-old/...` are not affected; query strings are
  preserved. Route parity is covered by
  `server/src/__tests__/api-path-aliases.myrmidon.test.ts`.

## changelog-ru

### Алиас старого пути API /api/paperclip/* (1.7-RB-PATH)

- Доребрендинговая поверхность API `/api/paperclip/*` теперь отвечает как
  прозрачный алиас канонических маршрутов `/api/myrmidon/*`: небольшая
  middleware, смонтированная первой внутри роутера `/api`, переписывает
  целый сегмент пути `/paperclip` в `/myrmidon`
  (`server/src/myrmidon/api-path-aliases.ts`).
- Те же обработчики, тот же контракт, те же коды ответов и заголовки — без
  redirect, поэтому существующие клиенты, которые всё ещё вызывают
  `/api/paperclip/...`, продолжают работать один релиз, пока кладётся
  ребрендинг (roadmap-v1 §3.3, OPE-3540 пункт B4).
- Пути вида `/api/paperclip-old/...` не затрагиваются; query-строка
  сохраняется. Паритет маршрутов покрыт тестом
  `server/src/__tests__/api-path-aliases.myrmidon.test.ts`.

## divergence

| 1.7-RB-PATH | Алиас пути API на один релиз: `/api/paperclip/*` отвечает ровно тем же контрактом, что `/api/myrmidon/*` — middleware `apiPathAliasMiddleware` (`server/src/myrmidon/api-path-aliases.ts`), смонтированная первой внутри роутера `/api` в `app.ts`, переписывает целый сегмент `/paperclip` → `/myrmidon` в `req.url`; без redirect, query сохраняется, пути вида `/api/paperclip-old/*` не переписываются | `server/src/myrmidon/api-path-aliases.ts` (+), `server/src/app.ts` (импорт + монтирование), тест `server/src/__tests__/api-path-aliases.myrmidon.test.ts` (+) | REBRAND (эпик OPE-3540, релиз 1.7), пункт B4 roadmap-v1 §3.3: переименование не должно сломать клиентов, вызывающих доребрендинговые пути API | `server/src/__tests__/api-path-aliases.myrmidon.test.ts` | Через один релиз после 1.7 (снять middleware и монтирование в `app.ts`) | (этот PR) |
