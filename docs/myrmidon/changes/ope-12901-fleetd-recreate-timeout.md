## changelog-en

### A fleetd bot recreate waits as long as a start (OPE-12901)

- The rc.27 rollout on 13.11 lost six fleetd bots (myr-vm1) to «fleetd POST
  /bots/<key>/recreate: timed out» and every card fell back to its old image; the retry
  minutes later passed 71/71 because the images were already on the host by then.
- Cause: `fleetdBotContainerDriver.recreate` issued its `callVoid` without a
  `timeoutMs`, so the board request carried the 60 s default while `start`/`restart`/
  `stop`/`writeProfile` get `START_TIMEOUT_MS` = 180 s. Recreating on a fleet host pulls
  the new image when it is not there yet, and a pull does not fit 60 s.
- Fix: the driver passes `START_TIMEOUT_MS` (180 s) to the recreate request, like a start.
  The fleetd protocol and the rollout scenario are unchanged.
- Operator note: without `MYRMIDON_BOT_IMAGE_ROLLOUT_FLEET_HOSTS` the rollout script does
  not pre-pull the release images on the fleet hosts (its step 2 skips the ssh pulls), so
  the first bot of a release recreates under an image pull. The SETTINGS row now says it.

## changelog-ru

### Пересоздание бота на fleetd ждёт столько же, сколько запуск (OPE-12901)

- Перекат rc.27 13.11 потерял шесть ботов на fleetd (myr-vm1) с ошибкой «fleetd POST
  /bots/<key>/recreate: timed out», и каждая карточка вернулась на прежний образ; повтор
  через несколько минут прошёл 71/71, потому что образы к тому моменту уже лежали на хосте.
- Причина: `fleetdBotContainerDriver.recreate` звал `callVoid` без `timeoutMs`, то есть с
  дефолтными 60 с, тогда как `start`/`restart`/`stop`/`writeProfile` идут с
  `START_TIMEOUT_MS` = 180 с. Пересоздание на хосте флота скачивает новый образ, если его
  там ещё нет, и скачивание не укладывается в 60 с.
- Исправление: драйвер передаёт в recreate `START_TIMEOUT_MS` (180 с) — как у запуска.
  Протокол fleetd и сценарий выката не менялись.
- Примечание оператору: без `MYRMIDON_BOT_IMAGE_ROLLOUT_FLEET_HOSTS` скрипт выката не
  скачивает образы релиза на хосты флота заранее (шаг 2 пропускает ssh-загрузки), поэтому
  первый бот релиза пересоздаётся под скачиванием образа. Теперь об этом сказано в строке
  SETTINGS.

## settings-en-replace

<!-- section: Track 5 — operations -->
<!-- occurrence: 1 -->
| `MYRMIDON_BOT_IMAGE_ROLLOUT_FLEET_HOSTS` | BOT-IMAGE-ROLLOUT | unset | Fleet hosts the bots run on (comma-separated, `remote:<user>@<host>` each, the `MYR_<COMPONENT>_HOST` shape): the images are pulled there and the fleetd `bots[]` is enrolled | Unset — everything bot-side happens on the local host, and the rollout does NOT pre-pull the release images on the fleet hosts: the first recreate of a new image pulls it fleetd-side under the recreate request |

## settings-ru-replace

<!-- section: Трек 5 — эксплуатация -->
| `MYRMIDON_BOT_IMAGE_ROLLOUT_FLEET_HOSTS` | BOT-IMAGE-ROLLOUT | не задан | Хосты флота, где работают боты (через запятую, каждый `remote:<user>@<host>`, как `MYR_<КОМПОНЕНТ>_HOST`): образы тянутся туда же и записывается `bots[]` fleetd | Не задан — всё бот-стороннее происходит на локальном хосте, и выкат НЕ скачивает образы релиза на хосты флота заранее: первый бот с новым образом скачивает его на пересоздании, под сам запрос recreate |
