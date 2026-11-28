## changelog-en

### Knowledge distiller recommendations (KNOWLEDGE-2.0 K-5)

- Suggestion lists expose the K-5 classifier's `recommendation` when the model supplies a valid accepted/rejected verdict and a non-empty reason. Otherwise, including legacy rows, `recommendation` is null. An existing non-empty `rationale` is preserved; an empty or missing one is null. Trust and auto-accept are independent.

## changelog-ru

### Рекомендации дистиллятора знаний (KNOWLEDGE-2.0 K-5)

- Список предложений возвращает `recommendation` классификатора K-5 при корректном вердикте accepted/rejected и непустой причине. Иначе, в том числе для старых записей, `recommendation` равна null. Существующая непустая `rationale` сохраняется; пустая или отсутствующая возвращается как null. Доверие и авто-принятие независимы от рекомендации.
