## changelog-en

### Browser bridge: `browser.sign` through a local signing helper (OPE-3383)

- The Chrome/Edge extension implements `browser.sign` and declares the `sign` capability and the `nativeMessaging` permission. It fetches the document in the page session, passes the bytes to the local signing helper over native messaging and reports only the status and the document digest; the key, the PIN and the signature never reach the gateway.
- Auto and manual signing are kept: the gateway now tells the extension the panel's decision in the `confirmation` param of every `browser.sign` step (`human` waits for a person on the PC), whatever the bot sent.
- The native messaging host name is `com.myrmidon.sign_helper` (Chrome rejects hyphens in host names).
- New CI workflow for `extension/`: typecheck, tests, build.

## changelog-ru

### Мост браузера: `browser.sign` через локальный хелпер подписи (OPE-3383)

- Расширение Chrome/Edge реализует `browser.sign`, объявляет возможность `sign` и разрешение `nativeMessaging`. Документ скачивается в сессии страницы, байты уходят локальному хелперу подписи по native messaging, наружу идут только статус и хэш документа; ключ, PIN и подпись до шлюза не доходят.
- Режимы подписи auto и manual сохранены: шлюз теперь сам сообщает расширению решение панели в параметре `confirmation` каждого шага `browser.sign` (`human` ждёт человека за ПК), что бы ни прислал бот.
- Имя хоста native messaging: `com.myrmidon.sign_helper` (Chrome не принимает дефис в имени хоста).
- Новый CI-воркфлоу для `extension/`: проверка типов, тесты, сборка.
