## changelog-en

### Bot containers: the image switch waits for an interrupted run to finalise (1.6.6 OPE-12150)

The bot container reconciler polled only 30 s past the maintenance drain deadline. R3 interrupts a busy run at the deadline, and a hermes gateway run took about 50 s to finalise, so every busy bot's switch to the release image failed seconds before the interrupt landed, the window closed and the retried run started on the old image again (prod 07.11, rc.46: 9 bots). The grace past the deadline is now 120 s.

## changelog-ru

### Контейнеры ботов: переключение образа ждёт, пока прерванный прогон завершится (1.6.6 OPE-12150)

Сверщик контейнеров ботов ждал после срока слива обслуживания только 30 с. R3 прерывает занятый прогон в срок, а прогон шлюза hermes завершался около 50 с. Поэтому переключение каждого занятого бота на образ выпуска срывалось за секунды до прерывания: окно закрывалось, и повтор прогона снова стартовал на старом образе (бой 07.11, rc.46: 9 ботов). Запас после срока теперь 120 с.
