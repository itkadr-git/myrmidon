## changelog-en

### BOT-HARDENING: what a bot container is created with, and `ulimit core=0` (OPE-12690)

- `docs/myrmidon/dockergate.md` (+ `dockergate.ru.md`) gained the section
  "What a bot container is created with": the exact container template of a
  bot and of the profile helper, flag by flag — `CapDrop ["ALL"]`,
  `SecurityOpt ["no-new-privileges"]`, `ReadonlyRootfs`, `Tmpfs /tmp`,
  `Init`, `Privileged false`, `RestartPolicy`, `PidsLimit`, `Ulimits
  [{Name: "core", Soft: 0, Hard: 0}]` — with the code location that sets and
  the one that pins every value. The helper keeps `CapAdd ["CHOWN",
  "FOWNER"]` only in the root `prepare-volumes` role and runs with
  `NetworkMode none`. For `fleetd` sites the section lists the differences:
  `no-new-privileges:true`, `MemorySwap` equal to `Memory`, `ShmSize` 64 MiB,
  and `PortBindings` for `8642/tcp` only.
- The `Ulimits core=0` paragraph answers the operator questions: it keeps a
  crashing process from writing a core dump onto the bot's bind volume, it
  takes effect on containers created after the rollout, existing bots are not
  recreated (the template-drift check does not compare `Ulimits`, pinned by
  `TestDriftFieldsIgnoresMissingUlimits`) and pick the flag up at their next
  recreate; inside the container it is visible as `ulimit -c` printing `0`.
- Docs only; no behaviour change. The same facts are already enforced by the
  shipped code: the gate accepts `HostConfig.Ulimits` pinned to
  `[{Name: "core", Soft: 0, Hard: 0}]` (#2660), the board driver and helper
  send it (#2872), fleetd does the same on remote sites (#2866).

## changelog-ru

### BOT-HARDENING: с чем создаётся контейнер бота, и `ulimit core=0` (OPE-12690)

- В `docs/myrmidon/dockergate.md` (+ `dockergate.ru.md`) появился раздел
  «С чем создаётся контейнер бота»: точный шаблон контейнера бота и
  помощника профиля, флаг за флагом — `CapDrop ["ALL"]`,
  `SecurityOpt ["no-new-privileges"]`, `ReadonlyRootfs`, `Tmpfs /tmp`,
  `Init`, `Privileged false`, `RestartPolicy`, `PidsLimit`, `Ulimits
  [{Name: "core", Soft: 0, Hard: 0}]` — с указанием кода, который значение
  задаёт, и кода, который его закрепляет. Помощник несёт `CapAdd ["CHOWN",
  "FOWNER"]` только в роли root-`prepare-volumes` и работает с
  `NetworkMode none`. Для площадок `fleetd` перечислены отличия:
  `no-new-privileges:true`, `MemorySwap` равный `Memory`, `ShmSize` 64 МиБ
  и `PortBindings` только для `8642/tcp`.
- Абзац про `Ulimits core=0` отвечает на вопросы оператора: он не даёт
  падающему процессу записать дамп ядра на bind-том бота, действует на
  контейнеры, созданные после выката, существующие боты не пересоздаются
  (сверка дрейфа шаблона `Ulimits` не сравнивает, это закрепляет
  `TestDriftFieldsIgnoresMissingUlimits`) и получают флаг при следующем
  пересоздании; внутри контейнера это видно как `ulimit -c`, печатающий `0`.
- Только документация; поведение не меняется. Те же факты уже закрепляет
  влитый код: шлюз принимает `HostConfig.Ulimits`, зажатый на
  `[{Name: "core", Soft: 0, Hard: 0}]` (#2660), драйвер и помощник доски
  его посылают (#2872), fleetd делает то же на удалённых площадках (#2866).
