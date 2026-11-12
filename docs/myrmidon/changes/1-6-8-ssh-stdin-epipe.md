## changelog-en

### SSH transfer streams no longer crash the board (1.6.8 SSH-STDIN-EPIPE)

- SSH and tar transfer stdin streams now handle early-close/write errors and reject the current transfer instead of emitting an unhandled `EPIPE`.
- Uploads stop the peer tar/ssh process when either side exits early.
- SSH/tar stderr retained for transfer errors is limited to a 64 KiB tail, with an explicit truncation marker.

## changelog-ru

### Потоки SSH-передачи больше не роняют доску (1.6.8 SSH-STDIN-EPIPE)

- Потоки stdin SSH и tar теперь обрабатывают раннее закрытие и ошибки записи и отклоняют текущую передачу вместо необработанного `EPIPE`.
- При раннем завершении одной стороны загрузки останавливается парный процесс tar/ssh.
- Сохраняемый для ошибок stderr SSH/tar ограничен хвостом 64 КБ с явной отметкой обрезки.
