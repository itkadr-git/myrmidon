## changelog-en

### UI2 plugin navigation and direct plugin-page loading (1.6.6)

- The UI2 desktop rail now has a Plugins group populated from installed plugin
  sidebar contributions and launchers. The mobile navigation exposes the same
  entries; it observes the plugin section's rendered height so page content
  reserves the space it needs.
- A plugin page loads its matching UI contribution when opened directly, rather
  than relying on the sidebar having loaded the plugin first.
- The release acceptance set is Personal bot, License issuer, Google AI Pro,
  ChatGPT and Antigravity. The rail and phone-nav tests cover the contribution
  and launcher rendering paths; they do not substitute for the pending live
  acceptance of each plugin's form.
- English and Russian labels are provided. The shell implementation is covered
  by rail, phone-navigation and direct-page tests.
- Verification recorded before this documentation follow-up: exact-head CI run
  [40354943018](https://github.com/itkadr-git/myrmidon/actions/runs/40354943018)
  passed on code head `e454535918d1e116be9a0bfb280e73f243f0194a`. This follow-up
  adds documentation; its own exact-head checks must be evaluated on the new
  commit. The live check of all five release plugins, direct URLs and forms at
  1440/390 in Russian remains ADM acceptance after the rc.17 rollout.
- Tests and implementation references: `ui/src/ui2/shell/Ui2Rail.tsx`,
  `Ui2Rail.plugins.test.tsx`, `Ui2PhoneNav.tsx`,
  `Ui2PhoneNav.plugins.test.tsx`, `ui/src/pages/PluginPage.tsx` and
  `PluginPage.test.tsx`.

## changelog-ru

### Навигация плагинов в UI2 и загрузка страниц по прямому адресу (1.6.6)

- В рейке UI2 появилась группа «Плагины», которая собирает слоты боковой
  панели и launcher-элементы установленных плагинов. Телефонная навигация
  показывает те же пункты и измеряет высоту секции плагинов, чтобы контент
  страницы резервировал необходимое место.
- Страница плагина загружает соответствующую UI-вклад напрямую при открытии
  URL, не полагаясь на предварительную загрузку из боковой панели.
- Добавлены подписи на английском и русском. Поведение покрыто тестами рейки,
  телефонной навигации и прямого открытия страницы.
- Ранее зафиксированная проверка до этого дополнения документации: exact-head
  CI [40354943018](https://github.com/itkadr-git/myrmidon/actions/runs/40354943018)
  прошёл на кодовой голове `e454535918d1e116be9a0bfb280e73f243f0194a`. Проверки
  нового exact-head после добавления документации ещё должны завершиться.
  Живая приёмка всех пяти релизных плагинов, прямых URL и форм на ширинах
  1440/390 в RU остаётся за ADM после выката rc.17.
- Тесты и реализация: `ui/src/ui2/shell/Ui2Rail.tsx`,
  `Ui2Rail.plugins.test.tsx`, `Ui2PhoneNav.tsx`,
  `Ui2PhoneNav.plugins.test.tsx`, `ui/src/pages/PluginPage.tsx` и
  `PluginPage.test.tsx`.
