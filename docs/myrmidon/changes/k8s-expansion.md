---
divergence-section: Трек 5 — эксплуатация
---

## changelog-en

### K8S-EXPANSION: orchestrator-managed k3s agent body

- Adds the 1.7 design contract for stateful agents on k3s hosted by Proxmox VMs.
  The Myrmidon orchestrator is the sole lifecycle and survivability authority:
  it owns wake, drain, hibernation, recovery, generations, fencing, and queue
  admission. Zabbix is diagnostic-only and cannot mutate lifecycle state; a
  future NATS path is an event transport, not a second source of truth. The
  design defines durable state, second-site recovery boundaries, failure drills,
  security boundaries, and staged acceptance criteria without claiming an
  unmeasured HA guarantee.

## changelog-ru

### K8S-EXPANSION: тело k3s агентов под управлением оркестратора

- Добавлен проектный контракт 1.7 для stateful-агентов в k3s на ВМ Proxmox.
  Единственный владелец жизненного цикла и живучести — оркестратор Myrmidon:
  он управляет wake, drain, гибернацией, восстановлением, поколениями,
  fencing и допуском очереди. Zabbix только диагностирует и не меняет lifecycle;
  будущий NATS — транспорт событий, а не второй источник истины. Проект фиксирует
  долговечное состояние, границы восстановления на второй площадке, дрели отказов,
  безопасность и поэтапные критерии приёмки, не обещая непроверенную HA-гарантию.

## divergence

| 1.7-K8S-EXPANSION | Добавлен проектный документ `docs/myrmidon/design/k8s-expansion.md` и русская версия: слоистая архитектура Proxmox → k3s → stateful agent, единственный владелец жизненного цикла (оркестратор), гибернация, поколения и fencing, восстановление на второй площадке, диагностическая граница Zabbix и будущий транспорт NATS | Нет: изменения только в документации | Зафиксировать решения и границы перед реализацией кластера и живучести агентов; не допустить второго управляющего контура через мониторинг | Документы содержат acceptance criteria, матрицу отказов, security boundaries и staged delivery; кодовых тестов нет, потому что реализация не входит в задачу | Наше архитектурное решение; снимать только при утверждённом новом дизайне 1.7 | (этот PR) |
