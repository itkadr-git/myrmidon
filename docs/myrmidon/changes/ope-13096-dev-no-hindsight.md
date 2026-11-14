## changelog-en

### Developers Hermes profile omits Hindsight memory provider (DEV-NO-HINDSIGHT, OPE-13096)

- For developer roles (`developerRoles`, e.g. `engineer`, `reviewer`, `release`), the Hermes profile compiler now omits `memory.provider: hindsight` from `config.yaml`. Developer agents do not require past memory loaded.
- For all other roles or when the role is unset, the profile remains byte-for-byte identical to the previous version.

## changelog-ru

### В профиле Hermes разработчикам не подключается Hindsight (DEV-NO-HINDSIGHT, OPE-13096)

- Для ролей разработчиков (`developerRoles`, таких как `engineer`, `reviewer`, `release`) компилятор профиля Hermes теперь исключает `memory.provider: hindsight` из `config.yaml`. Разработчикам не требуется память о прошлом.
- Для всех остальных ролей или если роль не задана, профиль остаётся байт в байт прежним.
