## changelog-en

### One-command installer opens the board by IP (OPE-5584)

- The installer now names the addresses of the machine (host names and global
  IPv4 addresses) in the board allow-list (`MYRMIDON_ALLOWED_HOSTNAMES` in
  `deploy.env`, passed to the board as `PAPERCLIP_ALLOWED_HOSTNAMES`). Before,
  the private hostname guard answered 403 to a request by the machine's own IP.
- The address printed at the end and used as the default public URL is the
  first IPv4 of the host instead of `hostname -f`, which resolves only where
  DNS knows the name. `MYRMIDON_ALLOWED_HOSTS` (comma-separated) overrides the
  detected list.

## changelog-ru

### Установщик «одной командой» открывает доску по IP (OPE-5584)

- Установщик вносит адреса машины (имена и глобальные IPv4) в список
  разрешённых адресов доски (`MYRMIDON_ALLOWED_HOSTNAMES` в `deploy.env`,
  в доску передаётся как `PAPERCLIP_ALLOWED_HOSTNAMES`). Раньше приватный
  охранник имён отвечал 403 на запрос по собственному IP машины.
- Адрес, который установщик печатает в конце и берёт публичным по умолчанию, —
  первый IPv4 хоста, а не `hostname -f`, который открывается только там, где
  DNS знает имя. `MYRMIDON_ALLOWED_HOSTS` (через запятую) переопределяет
  найденный список.
