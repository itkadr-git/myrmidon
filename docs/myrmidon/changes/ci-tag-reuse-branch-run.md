## changelog-en

### A release tag reuses the green CI run of its branch instead of a second full pipeline

A release is built on a `rel/*` branch and the `myr-v*` tag is cut on its head. The full "Myrmidon CI" already ran on that commit for the branch, and "Myrmidon CI (tag)" then ran the same full pipeline a second time on the tag. Both held the same runners and the release CI took about twice as long (seen on 16.11, 1.6.9).

- "Myrmidon CI (tag)" now starts with a `reuse branch CI` job. It looks for a "Myrmidon CI" run of the same commit started by a push or a manual dispatch (any branch; a pull request run is the fast tier and never counts). A run still in progress is waited for (polling, 70 minutes at most).
- If that run is green, the lanes of the tag workflow are skipped and `CI result` is success. If there is no such run (a short grace covers a run that is just starting), it is red or cancelled, the wait times out, or the check itself fails, the full pipeline runs exactly as before.
- The release freeze (`release-freeze.sh`) and the publish gate (`publish-github-release.sh`) accept the same green run of "Myrmidon CI" on the tag commit, on any branch, besides the tag's own run. A red run or a pull request run does not clear them.

## changelog-ru

### Тег выпуска берёт зелёный прогон CI своей ветки вместо второго полного конвейера

Выпуск собирается в ветке `rel/*`, тег `myr-v*` ставится на её голову. Полный «Myrmidon CI» на этом коммите уже прошёл для ветки, а «Myrmidon CI (tag)» затем гонял тот же полный конвейер второй раз на теге. Оба занимали одни и те же раннеры, и CI выпуска шёл примерно вдвое дольше (16.11, 1.6.9).

- «Myrmidon CI (tag)» теперь начинается с задания `reuse branch CI`. Оно ищет прогон «Myrmidon CI» на том же коммите от push или ручного запуска (любая ветка; прогон pull request — быстрый уровень и не считается). Идущий прогон дожидается опросом, не дольше 70 минут.
- Если этот прогон зелёный, задания тега пропускаются, а `CI result` даёт success. Если такого прогона нет (короткий запас на только стартующий), он красный или отменён, ожидание вышло по времени или сама проверка упала, полный конвейер идёт как раньше.
- Заморозка выпуска (`release-freeze.sh`) и ворота публикации (`publish-github-release.sh`) помимо собственного прогона тега принимают такой же зелёный прогон «Myrmidon CI» на коммите тега с любой ветки. Красный прогон или прогон pull request их не снимает.
