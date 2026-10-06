---
divergence-section: 1.6.1 — BOT-DISK B: общий кэш пакетов для контейнеров ботов
---

## divergence

| BOT-LAYOUT-V | Раскладка томов контейнера бота теперь производная ОТ КОНТРАКТА РАНТАЙМА ОБРАЗА, а не последнего шаблона доски. Контракт "1" (образы 1.6.4 и старше: три отдельных bind'а …/hermes:/data/hermes, …/workspace:/workspace, …/scratch:/scratch) получает старую трёхтомную раскладку; контракт "2" — один том …/&lt;botKey&gt;:/bot; образы перехода (контракт "1" + метка области myrmidon.bot-runtime.scope="1", сборки BOT-DISK-D/F, включая 1.6.5-rc.1) — тоже один /bot. Дрейф шаблона сравнивается с телом create, построенным под контракт ЭТОГО образа, поэтому карточка на старом образе больше не «дрейфует» по Binds и не пересоздаётся по схеме, которую образ не понимает; маркер и отчёт клон-гигиены такого контейнера читаются через /data/hermes (новый маршрут gate A3/A13). Образ без распознанного контракта по-прежнему отвергается до любого create. docker/bot-runtime/Dockerfile остаётся на label "1"+scope (переходное правило его корректно классифицирует как single); следующий релизный образ получает contract="2" синхронно с проверкой workflow myrmidon-bot-image.yml — это отдельный шаг сборки, не этот PR | Вендор: —. Наши файлы: `server/src/myrmidon/bot-containers/template.ts` (SUPPORTED_BOT_RUNTIME_CONTRACTS, declaredBotRuntimeContract, botVolumeLayout, раскладка в buildBinds, botRealRootFromBinds), `server/src/myrmidon/bot-containers/docker-driver.ts` (requireBotImage возвращает раскладку; createBody/templateDrift/create/recreate строят тело по контракту образа), `tools/dockergate` (policy пропускает обе формы bind'ов, image.go принимает контракты "1" и "2", маршрут A3/A13 читает legacy-маркер) | Второй дефект выката 1.6.5-rc.1: доска по ложному дрейфу Binds пересоздала 12 ботов с одним томом /bot под образом 1.6.4, искавшим $HERMES_HOME на отдельном томе, — пустой анонимный том, «API_SERVER_KEY is required», цикл перезапусков | `server/src/myrmidon/bot-containers/template.myrmidon.test.ts` (выбор раскладки по контракту, оба пути; buildBinds в обеих раскладках), `docker-driver.myrmidon.test.ts` (юнит на templateDrift: контейнер 1.6.4 против свежего legacy-тела — НЕТ дрейфа; create/recreate/writeProfile/start на legacy-образе против фейк-докера; reconcileBot: старая карточка сходится без recreate), `dockergate-contract.myrmidon.test.ts` (legacy-маркер в таблице маршрутов), Go: `policy/create_test.go`, `policy/image_test.go`, `gate/gate_allow_test.go` (A3 по /data/hermes), `gate/gate_deny_test.go` (порядок legacy-bind'ов строгий), фикстуры `contract/testdata/bodies/legacy-*.json` | Убрать переходное правило (contract "1" + scope → single) после того, как на бою не останется образов 1.6.4 без contract "2": тогда SUPPORTED сузится до "2" и Dockerfile поднимется синхронно с workflow-проверкой | [#—](https://github.com/itkadr-git/myrmidon/pull/0) |

## changelog-en

### The bot's volume layout follows its image's runtime contract (BOT-LAYOUT-V)

- A bot container is now created and recreated with the volume layout its IMAGE
  declares: contract "1" (the 1.6.4 and older images) keeps the three separate
  binds the image boots from; contract "2" gets the single /bot mount; the
  transition images (contract "1" plus the scope label) also get /bot. Template
  drift is compared against a create body built for the image's own contract,
  so a card on an old image neither reports a phantom Binds drift nor gets
  recreated under a layout its image cannot start with.
- The board reads the applied marker and the clone-hygiene report of a
  legacy-layout container through /data/hermes; dockergate allows exactly that
  path and nothing else under it.
- An image without a recognized contract is still refused before anything is
  created. Old 1.6.4 images stay supported under the new board for a smooth
  rollout; the bot-runtime Dockerfile is unchanged in this PR (the transition
  rule classifies it) — the image itself moves to contract "2" together with
  the myrmidon-bot-image.yml check in a release-engineering step.

## changelog-ru

### Раскладка томов бота следует контракту рантайма его образа (BOT-LAYOUT-V)

- Контейнер бота создаётся и пересоздаётся теперь с раскладкой томов, которую
  объявляет ЕГО ОБРАЗ: контракт "1" (образы 1.6.4 и старше) сохраняет три
  отдельных bind'а, из которых образ стартует; контракт "2" получает один том
  /bot; образы перехода (контракт "1" + метка области) — тоже /bot. Дрейф
  шаблона сравнивается с телом create, построенным под контракт самого образа,
  поэтому карточка на старом образе больше не даёт ложного дрейфа по Binds и не
  пересоздаётся по схеме, которую её образ не понимает.
- Маркер применённого профиля и отчёт клон-гигиены legacy-контейнера доска
  читает через /data/hermes; dockergate разрешает ровно этот путь и ничего
  больше под ним.
- Образ без распознанного контракта по-прежнему отвергается до любого
  создания. Старые образы 1.6.4 остаются поддерживаемыми под новой доской для
  плавного выката; Dockerfile образа в этом PR не меняется (его классифицирует
  переходное правило) — сам образ переходит на контракт "2" синхронно с
  проверкой myrmidon-bot-image.yml отдельным шагом релиз-инжиниринга.
