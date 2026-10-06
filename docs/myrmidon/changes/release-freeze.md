## changelog-en

### Release freeze: merges into main wait until the release tag's CI is green (RELEASE-FREEZE)

- A new PR check, `freeze` ("Release freeze gate"), fails while the newest
  release tag (`myr-vX.Y.Z` or `myr-vX.Y.Z-rc.N`) has no green Myrmidon CI.
  The tag workflow opens one issue `release-freeze: <tag>` at the cut and
  closes it when the tag CI succeeds. The gate fails closed on lookup errors.
- This prevents the 1.6.4 incident: merges right after the cut cancelled the
  tag's CI run and the publish gate refused the release.
- Operator step: add the `freeze` check to main's required status checks to
  make the freeze binding.

## changelog-ru

### Заморозка выпуска: слияния в main ждут зелёного CI на теге выпуска (RELEASE-FREEZE)

- Новая проверка PR `freeze` («Release freeze gate») красная, пока у
  последнего тега выпуска (`myr-vX.Y.Z` или `myr-vX.Y.Z-rc.N`) нет зелёного
  Myrmidon CI. Workflow тега при срезе открывает задачу
  `release-freeze: <тег>` и закрывает её, когда CI тега зелёный. При ошибке
  проверки гейт считает заморозку активной.
- Это закрывает инцидент 1.6.4: слияния сразу после среза отменили прогон CI
  на теге, и гейт публикации отказал.
- Шаг оператора: добавить проверку `freeze` в обязательные проверки main.
