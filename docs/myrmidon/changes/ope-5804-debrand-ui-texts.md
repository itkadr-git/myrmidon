---
divergence-section: Брендинг
---

## changelog-en

### UI copy debranded: visible "Paperclip" strings renamed to Myrmidon (DB1)

- All user-visible "Paperclip Cloud"/"Paperclip Labs"/"Paperclip EE"/"Paperclip Enterprise" strings across the web UI (pages, components, connection flows, OAuth handoff errors, placeholder examples) now read "Myrmidon …". Locales en/ru and the shared locale catalogs were swept in every language; MIT attribution lines (`about.base`, `about.attribution`) are untouched verbatim. Wire identifiers (`paperclip.*.v1` localStorage keys, adapter types, `paperclip_vault`, `X-Paperclip-*`, `@paperclipai/*`) keep their names until DEBRAND part c / stage 4.
- The branding-guard test (`ui/src/lib/myrmidon-branding-guard.myrmidon.test.ts`) tightened to a bare `\bPaperclip\b` scan: the vendor-product-word exceptions (Cloud/Labs/EE/Enterprise) are removed from its allowlist, so any new visible "Paperclip …" copy fails CI.

## changelog-ru

### Тексты UI дебрендированы: видимые строки «Paperclip» переименованы в Myrmidon (DB1)

- Все пользовательские строки «Paperclip Cloud»/«Paperclip Labs»/«Paperclip EE»/«Paperclip Enterprise» в веб-UI (страницы, компоненты, потоки подключения, ошибки OAuth-хендоффа, примеры-плейсхолдеры) переименованы в «Myrmidon …». Локали en/ru и общие каталоги локалей прочищены на всех языках; строки MIT-атрибуции (`about.base`, `about.attribution`) сохранены слово-в-слово. Идентификаторы протокола (`paperclip.*.v1`-ключи localStorage, типы адаптеров, `paperclip_vault`, `X-Paperclip-*`, `@paperclipai/*`) не переименованы — это часть c / этап 4.
- Тест-сторож брендинга (`ui/src/lib/myrmidon-branding-guard.myrmidon.test.ts`) ужесточён до голого скана `\bPaperclip\b`: исключения по словам вендора (Cloud/Labs/EE/Enterprise) из аллоулиста убраны — любая новая видимая строка «Paperclip …» не пройдёт CI.

## divergence

| DB1 | Видимые тексты вендорных названий в UI (Paperclip Cloud/Labs/EE/Enterprise) переименованы в Myrmidon-аналоги: App.tsx (cloudCreateUnavailable ×2), ConnectionSetupFlow, oauthHandoff (OAuthHandoffError тексты), Secrets/AdapterManager/CompanyEnvironments плейсхолдеры, AuditFeed (+production) «Myrmidon Enterprise view», InstanceExperimentalSettings «Managed by Myrmidon Cloud», TrustPresetSection «Get Myrmidon EE», Labs-строки фидбек-настроек (AgentBubbleActionRow/IssueChatThread/OutputFeedbackButtons), InviteUxLab demo-домен myrmidon.local, Cases «See the Myrmidon skill»; локали myrmidon-locales/en+ru прочищены, locales/*.json содержат только атрибуцию about.base/about.attribution (слово-в-слово, не тронута) | ui/src (App.tsx, pages/, components/, features/connections/, lib/oauthHandoff.ts, i18n/myrmidon-locales/) | DEBRAND 1.6.6-a (OPE-5804, ROADMAP OPE-5794): «Paperclip» в пользовательских строках UI недопустим; идентификаторы протокола/localStorage — часть c/этап 4 | myrmidon-branding-guard.myrmidon.test.ts ужесточён до `\bPaperclip\b` без исключений Cloud/Labs/EE/Enterprise; locale-validation + myrmidon-i18n зелёные | Никогда. При переносе вендорских файлов UI-тексты править на Myrmidon, метка myrmidon(DB1); аллоулист сторожа не расширять | OPE-5804 (1.6.6 DEBRAND-a) |

## divergence-replace

<!-- section: Известные пробелы -->
| B1 | «Paperclip» всё ещё в человеко-видимом тексте повторяющихся составных названий — «Paperclip Runner», «Paperclip Cloud», «Paperclip-managed», OAuth/MCP-описания клиентов и коннекторов в `tool-access.ts`/`tool-gateway.ts`/`paperclip-cloud-connector*.ts`/`provider-profile.ts`/`execution-workspaces.ts`/`company-skills.ts`/`secrets.ts` и др. (список файлов — раздел «Брендинг» выше); эти названия используются десятками раз в разных файлах и требуют одного согласованного прохода, а не частичной правки нескольких мест | UI ошибок MCP-раннера, экран Runner/Cloud-подключения, OAuth-согласие, сообщения об окружении прогона | Закрыт проходом B1c (см. строку B1c в разделе «Брендинг») — остатки переведены на PRODUCT_NAME; «Paperclip» остаётся только в идентификаторах, MIT-атрибуции и именах внешних сервисов вендора. UI-часть закрыта DB1 (OPE-5804): видимые строки веб-UI прочищены, сторож брендинга ужесточён |
