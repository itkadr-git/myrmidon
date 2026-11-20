## changelog-en

### Knowledge distiller recommendations (KNOWLEDGE-2.0 K-5)

- Suggestion lists expose the K-5 classifier's `recommendation` and `rationale` only when the model supplies a valid accepted/rejected verdict and a non-empty reason. Otherwise, including legacy rows, they are null. Trust and auto-accept are independent.

## changelog-ru

### Рекомендации дистиллятора знаний (KNOWLEDGE-2.0 K-5)

- Список предложений возвращает `recommendation` и `rationale` классификатора K-5 только при корректном вердикте accepted/rejected и непустой причине. Иначе, в том числе для старых записей, значения равны null. Доверие и авто-принятие независимы от рекомендации.
