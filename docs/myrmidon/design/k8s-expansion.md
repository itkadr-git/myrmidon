# K8S expansion: the orchestrator-managed agent body

> Russian version: [k8s-expansion.ru.md](k8s-expansion.ru.md)

Revision of 11.10.2026, release 1.7 design decision.

## 0. Decision in one page

Myrmidon will run stateful agent workloads in a small **k3s cluster hosted by
Proxmox virtual machines**. Proxmox is the infrastructure layer; k3s is the
workload layer; the Myrmidon orchestrator is the only component that owns agent
lifecycle and survivability decisions.

The first implementation is deliberately narrower than a general Kubernetes
platform:

- the board asks an orchestrator-owned runtime adapter to place, wake, drain,
  hibernate, and recover an agent;
- an agent's durable identity and state live on storage independent of its pod;
- hibernation stops compute while retaining the state volume and the desired
  specification;
- a reconcile loop turns the desired state into an observed state and retries
  every operation idempotently;
- Zabbix is a **diagnostic source only**. It may report symptoms to the board,
  but it never restarts, migrates, hibernates, or promotes an agent;
- a later NATS integration may distribute lifecycle events, but it is not a
  prerequisite for correctness.

The control plane must remain useful when the monitoring system is unavailable.
Conversely, monitoring may report a stale or incomplete view without becoming a
second orchestrator.

## 1. Goals and non-goals

### Goals

1. Place one or more agent workloads on k3s nodes running inside Proxmox VMs.
2. Preserve agent identity, memory, workspace, and runtime configuration across
   pod recreation and hibernation.
3. Wake an agent on demand, wait for a readiness proof, and only then release
   queued work to it.
4. Detect and recover from a dead pod, dead node, lost VM, or interrupted
   lifecycle operation without two live owners acting on the same agent.
5. Make the second site a survivability target without requiring a stretched
   Kubernetes cluster as the first step.
6. Keep all lifecycle policy in the orchestrator, with auditable transitions and
   bounded retries.
7. Provide diagnostics through Zabbix without giving Zabbix control-plane
   authority.

### Non-goals for this slice

- Proxmox becomes a user-facing resource editor in the board.
- Agents share a filesystem or a pod merely to save memory.
- Zabbix automation executes corrective actions.
- The first release provides a multi-site, synchronous, zero-loss database.
- A generic Kubernetes scheduler replaces the board's queue, budgets, leases, or
  approvals.
- NATS becomes a required source of truth before its delivery and replay
  semantics are specified.

## 2. Layered topology

```
                         Myrmidon board
                 desired state, queue, leases, policy
                                |
                    orchestrator runtime adapter
             reconcile / wake / drain / hibernate / recover
                                |
                 k3s API (inside the managed cluster)
          server VMs + worker VMs, all provisioned on Proxmox
                                |
                stateful agent pods + durable volumes
                                |
             primary site  <---->  second-site recovery copy

       Zabbix: probes and metrics ----> board diagnostic alert endpoint
       NATS (later): lifecycle event distribution, never authority
```

### 2.1 Proxmox VMs

Proxmox supplies VMs, disks, network attachment, and host-level recovery. Its
API is used by the deployment/operator layer and by the runtime adapter only
through a narrowly scoped infrastructure interface. No agent receives
Proxmox credentials, and no agent-supplied value becomes a VM or network
command.

The board does not infer workload health from a Proxmox ping. A VM can be
reachable while k3s or the agent is unhealthy; these are separate observed
conditions.

### 2.2 k3s

The cluster is a workload substrate, not the business control plane. The
cluster's own desired objects (namespaces, service accounts, workloads,
volumes, and policies) are generated from orchestrator-owned records. The
adapter uses stable labels containing the agent identity and generation, so it
can discover only objects it owns.

For a production HA installation, use an odd number of k3s server VMs and keep
quorum in one failure domain until the second-site replication protocol is
proved. A second site starts as a warm recovery target, not as a stretched
quorum member. The exact VM count, storage backend, and placement groups are
installation parameters, not application assumptions.

### 2.3 Agent workload

An agent pod is disposable. Its durable state is not:

- the agent identity and board-side policy remain in Myrmidon;
- the runtime home, memory database, and workspace use durable volumes according
  to the agent's storage class;
- secrets are projected just in time and are never copied into the desired
  object or diagnostic payload;
- the pod receives a generation and a bounded runtime lease;
- a pod is considered usable only after the runtime readiness contract passes.

A pod restart is therefore not an identity change. A new identity or a changed
state volume requires an explicit board operation and an audit record.

## 3. Ownership and source of truth

There is exactly one lifecycle owner: **the Myrmidon orchestrator**.

| Concern | Authority | Read by |
|---|---|---|
| Should an agent be running or hibernated? | board policy + queue demand | orchestrator, UI |
| Which image, model, limits, and volumes apply? | agent card snapshot at reconcile start | orchestrator, adapter |
| Is the workload currently usable? | orchestrator readiness observation | queue gate, UI |
| Is the node/VM technically reachable? | k3s and infrastructure observations | orchestrator, diagnostics |
| Is a symptom worth showing to an operator? | Zabbix → board alert intake | UI, runbooks |
| Delivery of lifecycle notifications | NATS later, derived from board events | consumers |

Kubernetes status is an observation, not an instruction. Zabbix status is an
observation, not an instruction. A stale observation cannot override the last
board decision.

Every mutable agent runtime record has a monotonically increasing `generation`.
The adapter must include it in object labels and compare it before applying a
late result. A result from an older generation is recorded as stale and cannot
promote a pod, release a queue lease, or change the desired state.

## 4. Lifecycle state machine

The board stores desired state separately from observed state. The minimum
observed states are:

```
unknown → provisioning → ready → draining → hibernated
             │             │          │
             └─────────────┴──────────┴──► recovering ─► ready
                                  └──────────────► failed
```

`unknown` means that no trustworthy observation exists; it does not mean
healthy. `failed` is a diagnostic outcome and is not an implicit instruction to
retry forever.

### 4.1 Wake

1. The queue asks the orchestrator for an agent admission.
2. The orchestrator records `desired=running`, increments the generation when
   the specification changed, and obtains a single-flight lifecycle lease.
3. The adapter ensures the namespace, service account, volume claims, and
   workload exist with the expected generation.
4. The adapter waits for the runtime readiness contract and records the observed
   result with timestamps and a reason.
5. Only after readiness does the board dispatch queued work and issue the agent
   runtime lease.

A duplicate wake returns the existing operation. A timeout leaves the agent in
`recovering` or `failed` with the queued work intact; it does not create a
second pod or silently drop work.

### 4.2 Drain and hibernate

Hibernation is a controlled transition, not a kill:

1. stop admitting new work to the agent;
2. let the current run finish, or apply the existing bounded interruption and
   retry policy;
3. flush runtime state and record the last checkpoint;
4. revoke the runtime lease and remove the serving endpoint;
5. scale the compute workload to zero (or stop the pod) while retaining durable
   volumes and the desired specification;
6. record `hibernated` only after the adapter confirms that no serving pod for
   the generation remains.

If any checkpoint or drain step fails, the state stays visible as `draining` or
`failed`; the orchestrator does not claim that the agent is hibernated.

### 4.3 Recovery

Recovery is initiated by the orchestrator from a failed readiness probe, a
missing pod, a lost node, a lost VM, or an operator request. It is not initiated
by a Zabbix action. The recovery operation is idempotent and has a finite retry
budget. On exhaustion, the agent remains failed, queued work remains queued or
is escalated according to board policy, and the operator receives one deduped
attention item.

A recovered agent must pass the same readiness proof as a woken agent. Reusing
a volume never bypasses schema/version checks or secret projection checks.

## 5. Persistence and survivability

### 5.1 State classes

| State | Location | Recovery rule |
|---|---|---|
| Board identity, policy, queue, leases, audit | Myrmidon database | database backup/restore and normal board recovery |
| Runtime home and memory | durable per-agent volume | attach only to the matching agent identity |
| Workspace | durable workspace volume or declared external workspace | preserve according to workspace policy; never assume pod-local disk |
| Pod/network process state | k3s | recreate from desired state |
| Metrics and logs | observability systems | useful for diagnosis, not required for identity |

Pod-local ephemeral storage is cache only. An agent must not report a successful
checkpoint while important state remains only on the pod filesystem.

### 5.2 Second site

The second site is a recovery destination for the board database, agent durable
state, and the k3s bootstrap material. Replication must expose a freshness
watermark and a last-known-good point to the operator. During a site loss:

- the surviving board/orchestrator instance is fenced before promotion;
- stale lifecycle operations from the old site are rejected by generation and
  fencing tokens;
- the recovery site restores durable state first, then recreates only the
  workloads that policy marks as required;
- agents without a complete durable-state copy remain `failed`, never silently
  start with an empty identity;
- queued work is reconciled from the board database after promotion.

This design intentionally prefers explicit degraded service over split-brain
execution. RPO/RTO values, storage replication technology, and promotion
approval belong to the deployment design and must be measured before claiming
HA.

## 6. Zabbix and future NATS boundary

### Zabbix: diagnostics only

Zabbix may monitor VM, k3s, storage, pod, and readiness signals. A Zabbix alert
is normalized into a board attention item or issue with its source, fingerprint,
severity, and recovery event. The alert handler must be idempotent and must not
call the lifecycle adapter.

In particular, Zabbix must not:

- restart or delete a pod;
- scale an agent up or down;
- move a volume or promote the second site;
- release a board lease or mark an agent ready;
- run an arbitrary Proxmox or kubectl command.

The board's own reconciler may use the same raw symptoms as evidence, but its
policy and observed state remain authoritative. If the Zabbix link is down,
agent lifecycle continues; only diagnostics degrade.

### NATS: later event transport

When introduced, NATS will carry derived, signed lifecycle events such as
`agent.ready`, `agent.hibernated`, `agent.recovery_failed`, and
`site.promoted`. Events contain an event id, agent identity, generation,
sequence, and board timestamp. Consumers must tolerate duplicate and out-of-
order delivery and must not treat an event as permission to mutate lifecycle
state. The board database remains the source of truth; NATS is a transport and
replay aid.

## 7. Security boundaries

- k3s service accounts are per controller function; the reconciler cannot read
  unrelated namespaces.
- Proxmox credentials, storage credentials, and cluster bootstrap material are
  board/operator secrets, never agent environment variables.
- Agent runtime credentials are scoped to the agent and projected only during a
  run. They are not placed in labels, annotations, events, or Zabbix payloads.
- Network policy denies agent-to-control-plane access except for the declared
  runtime endpoints. Control-plane calls use allowlisted APIs.
- Every lifecycle mutation records actor, agent, generation, desired/observed
  states, reason, and result. Secret values and internal addresses are excluded.
- Recovery and site promotion require the existing board authorization and
  approval rules; an alert cannot elevate itself into an operator action.

## 8. Failure matrix

| Failure | Board state | Required response |
|---|---|---|
| pod disappears | `recovering` | recreate same generation after fencing the old object |
| worker VM disappears | `recovering` | let k3s reschedule, then verify volume attachment and readiness |
| Proxmox host unavailable | `recovering`/`failed` | retry within budget; escalate once; no blind promotion |
| volume attach/checkpoint fails | `failed` | keep work queued, preserve evidence, require operator or policy decision |
| k3s API unavailable | `unknown` or last observed state marked stale | do not dispatch new work; retry with backoff |
| Zabbix unavailable | unchanged lifecycle state | keep reconciling; create no synthetic recovery action |
| board/orchestrator restart | state restored from DB | resume idempotent operations using generation and fencing |
| site loss | fenced old site, recovery site `promoting` | restore watermark, require promotion policy, then reconcile |

No failure path converts `unknown` into `ready` merely because a timeout
expired.

## 9. Delivery phases

1. **Contract and simulator.** Define runtime adapter interfaces, state machine,
   generation/fencing rules, readiness contract, and fake k3s/Proxmox adapters.
2. **Single-site k3s.** Run one non-critical agent class, with durable volumes,
   wake/drain/hibernate, queue gating, audit, and explicit operator recovery.
3. **Failure drills.** Kill pods, workers, VMs, the k3s API, and the board during
   each transition. Verify no duplicate owner, no lost queue item, and correct
   stale-generation handling.
4. **Second-site recovery.** Prove database and volume restore with measured
   RPO/RTO, fencing, and promotion approval before calling the installation
   survivable.
5. **Zabbix diagnostics.** Add read-only probes and deduped board alerts after
   lifecycle facts are stable. Keep Zabbix automation disabled.
6. **NATS event transport.** Add only after event schemas, replay, and consumer
   idempotency are reviewed; it does not replace the database or reconciler.

## 10. Acceptance criteria

The implementation is ready for a staged rollout when all of these are true:

- a test agent survives pod recreation with the same identity and durable state;
- wake, drain, and hibernate are idempotent under duplicate requests and
  orchestrator restarts;
- a queued task is not dispatched before readiness and is not lost during
  hibernation or node loss;
- stale generation results cannot release a lease or mark an agent ready;
- each injected failure in the matrix has a bounded, observable outcome;
- Zabbix outage does not stop lifecycle reconciliation, and a Zabbix alert
  cannot mutate lifecycle state;
- the second-site drill records measured RPO/RTO and rejects split brain;
- audit records contain no secret values, credentials, or internal addresses;
- operator runbooks explain how to inspect, retry, fence, and promote without
  issuing ad-hoc commands from an agent.

## 11. Open decisions before implementation

These are intentionally deployment-level decisions, not hidden in application
code:

- k3s server count and VM placement across the primary site;
- storage backend and the supported volume replication/failover mechanism;
- RPO/RTO and the promotion approver for the second site;
- the exact runtime readiness probe and checkpoint protocol;
- whether the first agent class permits hibernation while its workspace has an
  active external lock;
- the NATS subject naming, retention, and signing key rotation policy.
