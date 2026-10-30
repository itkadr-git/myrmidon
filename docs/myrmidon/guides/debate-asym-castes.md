# Debates per caste and the «Discuss» button on a caste's task (1.7 DEBATE-ASYM B)

> Russian version: [debate-asym-castes.ru.md](debate-asym-castes.ru.md)

Part A ([debate-asym.md](debate-asym.md)) configures the debate engine once for
the whole instance. The castes, however, do different work: the marketing caste
argues about a campaign claim, the engineering caste about a migration, and the
free models that fit one pair of roles are not automatically the right pair for
the other. Part B gives **every caste its own knobs** and puts the run where the
work is seen — on the task of that caste, in the swarm supervisor's role queue.

## What a caste may set

| Knob | Meaning |
|---|---|
| **Switch** | whether debates may run for this caste at all. Debates are ON for a caste that has no entry of its own (the instance configuration is already an explicit operator choice, the models are free by default); the switch exists to take a caste OUT — a caste whose work should not spend gateway calls, or one being piloted later |
| **Role models** | generator, critic and judge for this caste. The cross-family rule is unchanged and is re-checked on the **merged** configuration: a caste that overrides only the critic cannot slip a same-family judge past it |
| **Guidance per role** | extra instructions for each role. The text is **appended to the built-in pole prompt** and never replaces it: the critic keeps its adversarial pole and its missed-error penalty, the generator its constructive one, the judge its place outside the dispute. A caste narrows where a role looks; it cannot change the nature of the dispute |
| **Rounds** | 1..3, never more (the owner rule) |
| **Token ceiling** | the total-token ceiling of a debate of this caste |

## Where it is set

The screen is **Instance → General → Asymmetric debates → Debates per caste**
(the section sits inside the debate panel next to the instance-level roles), and
the API is:

| Call | Body / answer |
|---|---|
| `GET /api/myrmidon/companies/:companyId/debates/castes/:casteKey/settings` | the effective values, the source of each part, the stored entry, and whether the gateway is configured. Board-readable |
| `PATCH` on the same path | `{ "settings": { enabled, generator, critic, judge, rounds, tokenCeiling, prompts } }` — or `{ "settings": null }` to clear the entry back to inheriting. **Instance admin only** (the entry lands in the instance settings value, the same rule the instance-level PATCH follows), and every save is written to the activity log (`debate.caste_settings.saved`) |

The entry is stored **beside the instance configuration**, inside the same
`instance_settings.general.debate` value:

```jsonc
{
  "generator": { "model": "qwen-plus-free" },   // instance level (part A)
  "critic":    { "model": "glm-4-flash-free" },
  "judge":     { "model": "deepseek-chat-free" },
  "rounds": 3,
  "tokenCeiling": 50000,
  "castes": {                                    // part B, one entry per caste
    "marketing": {
      "companyId": "…",                          // written by the server, never by the caller
      "enabled": true,
      "critic": { "model": "glm-4-flash-free" },
      "rounds": 2,
      "tokenCeiling": 20000,
      "prompts": { "critic": "check the legal claims of the campaign" }
    }
  }
}
```

Two consequences worth knowing:

- **No migration and no restart.** The value already owns the engine configuration
  and its preserve key (part A keeps it alive across vendor writes of
  `instance_settings`), and it is read at run/PATCH time, never cached at boot —
  so a save reaches the next debate immediately.
- **The entry is pinned to its company.** Castes are company-scoped rows; an
  entry whose `companyId` does not match the caste being resolved is inert and
  reported as ignored, never silently applied to a same-named caste elsewhere.

## Precedence

For a caste: the **caste entry** over the **instance configuration** (stored row
→ `MYRMIDON_DEBATE_CONFIG` → built-in default). Every screen caption names its
source: *Set for this caste* / *Inherited from the instance level (…)*, and the
switch has its own caption (*Set for this caste* / *On by default — no per-caste
switch saved yet*).

Nothing degrades silently. A caste entry that is malformed, or a merged
configuration that breaks the asymmetry rule, is refused with the exact reason
and nothing is stored; at run time such a caste refuses the run with
`debate_config_rejected` (422).

## Running a debate from a task

The **«Обсудить» / «Discuss»** button sits on every row of the **caste's task
queue** on `/swarm-claim` (Swarm supervisor → role queues). Clicking it starts
one debate about that task with the row's caste (`POST …/debates/issues/:issueId/run`
with `{ "casteKey": "<row role>" }`) and shows the result right under the button:

- the judge's verdict (first line),
- how the debate stopped (`agreement` / `rounds_exhausted` / `token_ceiling`) and why,
- the rounds, the tokens against the ceiling, and the cost,
- the caste the debate ran for, and which roles argued with custom guidance,
- the name of the result document left on the task.

The full transcript, the roles and the cost land on the task as the
`debate-result` document (part A's writer), and the spend is recorded as
task-level cost events, so BUDGET-CONFIG counts it like any other work.

Refusals are shown, never swallowed:

| Answer | When | What the screen shows |
|---|---|---|
| `422 debate_caste_disabled` | the caste's switch is off | the reason plus a hint where the switch lives (Instance → General → Asymmetric debates → Debates per caste) |
| `422 debate_config_rejected` | the resolved configuration cannot run (family rule) | the exact reason from the server |
| `404 debate_caste_not_found` | the row's role is not in the company's caste directory | the server's message |
| `503` | the gateway (evals/debate contour) is not configured | the gateway problem |
| `403 autonomy_*` | an **agent** caller not allowed by the autonomy matrix | the approval/forbidden code — a debate spends gateway calls, so agent callers are gated on `spend_above_threshold`; the board bypasses the matrix |

A task that is **not routed to a caste** keeps part A's behaviour: a run without
`casteKey` and without an assignee uses the instance-level configuration and the
result document says nothing about a caste. The button always names the caste of
the row it sits on.

## The pilot: the marketing caste

1. Make sure the engine itself is configured: Instance → General → Asymmetric
   debates (or `PATCH /api/myrmidon/debate/settings`) has three role models from
   three families, and the gateway is reported as configured.
2. Pick the **marketing** caste in *Debates per caste*, check the switch is on,
   and save this caste's models, rounds, ceiling and — if the caste needs it —
   its own guidance per role (for example: the critic is told to check the legal
   claims of a campaign, the generator to keep the answer to the channel plan).
   The values shown before saving are the effective ones, with their source.
3. Open `/swarm-claim`, find a marketing task in that role's queue and press
   **«Обсудить»**. The result appears under the button; the same run leaves the
   `debate-result` document on the task.
4. Watch the spend: the debate writes cost events on the task, so the
   BUDGET-CONFIG views show it at the task level like any other spend. Free
   models cost 0 — the tokens are still counted against the ceiling.

## Removing this

Everything of part B is ours: `packages/shared/src/myrmidon-debate-castes.ts`,
the caste routes and store (`server/src/myrmidon/debates/{castes,routes,service}.ts`),
the two screens (`ui/src/components/myrmidon/CasteDebateSettingsPanel.tsx`,
`DebateTaskButton.tsx`), the fork locale keys `swarm.discuss*`. Vendor files
touched are only marked with `myrmidon(1.7-DEBATE-ASYM-B)` comments (the export
line in `packages/shared/src/index.ts`); see `docs/myrmidon/DIVERGENCE.md`.
Removing part A removes part B with it: the caste map lives inside part A's
stored value, so deleting the `debate` key and the panel removes both levels.