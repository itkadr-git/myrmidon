## divergence-new

<!-- after: 1.6.5 — F-26 T10 SWARM-SCENT: запах задачи и агента, логика Jev -->

### 1.7 — UI-2.0: тесты разделов настроек (OPE-10138)

| ID | Что изменено | Файлы | Зачем | Тесты | Когда снимать | Ссылка |
|---|---|---|---|---|---|---|
| 1.7-UI2-SETTINGS-SECTIONS | Маршрут `company/settings/guards` в `boardRoutes` для предотвращения «Page not found» (OPE-9379) и регрессионный тест 11 путей настроек UI-2.0 | `ui/src/App.tsx` (импорт `Ui2PlaceholderScreen` и маршрут `company/settings/guards`), `ui/src/ui2/routes.tsx` (экспорт `Ui2PlaceholderScreen`) | Предотвратить 404 на `guards` и регрессии рендеринга настроек UI-2.0 (OPE-10138) | `ui/src/ui2/tests/ui2SettingsSections.myrmidon.test.tsx`, `ui/src/ui2/tests/ui2Screens.myrmidon.test.ts` | Никогда, штатный маршрут настроек | (этот PR) |
