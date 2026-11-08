## changelog-en

### A bot on a remote site can read its managed skills

fleetd writes the profile files of a bot on a remote site. It created the missing directories of a
file as its own user and gave the bot user only the file's own directory. So `hermes/skills` and
`hermes/skills/paperclip-managed` stayed owned by root with mode 0700, and the bot gateway failed:
"Permission denied: /data/hermes/skills/paperclip-managed". fleetd now gives the bot user every
directory between the bot volume root and the file. The volume root itself stays as it is.

## changelog-ru

### Бот на удалённой площадке видит свои управляемые навыки

fleetd записывает файлы профиля бота на удалённой площадке. Недостающие каталоги для файла он
создавал от своего пользователя, а пользователю бота отдавал только каталог самого файла. Поэтому
`hermes/skills` и `hermes/skills/paperclip-managed` оставались у root с правами 0700, и шлюз бота
падал: «Permission denied: /data/hermes/skills/paperclip-managed». Теперь fleetd отдаёт пользователю
бота все каталоги между корнем тома бота и файлом. Сам корень тома не меняется.
