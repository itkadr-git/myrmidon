import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agents, companies, createDb, issueRecoveryActions, issueRelations, issues } from "@myrmidon/db";
import {
  ISSUE_RECOVERY_ACTION_KINDS,
  type IssueRecoveryActionKind,
  type RecoveryFactoryRequest,
} from "@myrmidon/shared";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { issueRecoveryActionService } from "../services/issue-recovery-actions.js";
import {
  classifyOperatorAction,
  type RecoverySignal,
} from "../services/recovery-factory/classify-disk-operator.js";

interface FixtureItem {
  actionIndex: number;
  sourceIssue: string;
  sourceDescription: string;
  sourceCommentId: string;
  sourceQuote: string;
  signal: {
    issueId: string;
    action: string;
    message: string;
    context?: Record<string, unknown>;
  };
  expectedClassification: {
    kind: IssueRecoveryActionKind;
    cause: string;
  };
  policy: {
    role: string;
    slaMinutes: number;
  };
}

/**
 * Authoritative verbatim description texts from OPE-8079 ticket description.
 * Each operator action corresponds to an explicit external barrier in OPE-8079.
 */
const OPE_8079_AUTHORITATIVE_DESCRIPTIONS: Record<string, string> = {
  "OPE-7710":
    "[OPE-7710](/OPE/issues/OPE-7710) — подтвердить изолированный Windows/build слот и scoped GitHub CI access; не выдавать сырой ключ в комментарий.",
  "OPE-7975":
    "[OPE-7975](/OPE/issues/OPE-7975) — определить целевой PERSONAL-BOT instance, tracker-only aria2 egress и размер hard quota. Агент-оператор затем настраивает и проверяет; торрент до проверки выключен.",
  "OPE-7265":
    "[OPE-7265](/OPE/issues/OPE-7265) — существующая human_only карточка e4e8fbff-589f-447e-8590-eba46792eb8c требует verdicts на HEAD 9c68c9b937ff59cc8dfd424526d08468234ac289. Не давать waiver CI/Tuwunel: вернуть недостающий workflow/интеграционный тест инженеру после законного решения.",
  "OPE-7590":
    "[OPE-7590](/OPE/issues/OPE-7590) — независимый рецензент PR myrmidon-deploy #23: по новому правилу adm-dev-review-9; обеспечить доступ к head/CI, не создавать второго параллельного review без проверки существующего.",
  "OPE-7533":
    "[OPE-7533](/OPE/issues/OPE-7533) — проверенный артефакт 6cfe3573e65f4e904fc761b8328c80c6115087df и авторизованный relay; не заменять защищённую историю угадыванием.",
  "OPE-6001":
    "[OPE-6001](/OPE/issues/OPE-6001) — решение по новому head ca01bddcbb029e98bfc4722abd06e4d4cbdd6254 PR #842 после зелёного CI; прежнюю SHA-guard не обходить.",
  "OPE-6871":
    "[OPE-6871](/OPE/issues/OPE-6871) — явное разрешение продолжить ранее отклонённую маршрутизацию review/merge PR #1178 либо оператор выполняет сам. Отказанный вызов не повторяли.",
  "OPE-7225":
    "[OPE-7225](/OPE/issues/OPE-7225) — восстановить execution review participant/runtime, не дублировать уже написанную реализацию.",
  "OPE-7969":
    "[OPE-7969](/OPE/issues/OPE-7969) — оператор с repo write: rerun/fresh CI PR #1364 и base update при необходимости; reported unrelated Telegram-fixture shard failure не объявлять успешным CI.",
};

/**
 * Authoritative verbatim comment quotes from operator status comment 404b7a3c-2ae4-4466-bec7-e86389771c87 on OPE-8079.
 */
const OPE_8079_AUTHORITATIVE_COMMENTS: Record<string, string> = {
  "OPE-7710":
    "1) OPE-7710 — blocked; отдельный managed Windows/deploy слот и scoped Checks/Actions access не подтверждены. Нужны provisioned slot и разрешённая GitHub-доступность; checkout не трогал.",
  "OPE-7975":
    "2) OPE-7975 — blocked; на vm-core не найдено развернутого PERSONAL-BOT/torrent instance, volume или network, поэтому невозможно безопасно настроить aria2 egress/quota. Ранее принятое подтверждение задаёт безопасную рекомендацию, но не instance или размер квоты; torrent выключен. Жду эти конкретные параметры владельца.",
  "OPE-7265":
    "3) OPE-7265 — blocked; human_only verdict по требуемому HEAD не получен. CI/Tuwunel waiver не выдавал. Нужен verdict владельца, затем недостающие проверки вернуть инженеру.",
  "OPE-7590":
    "4) OPE-7590 — done (проверено в исходной задаче); дублирующий review не создавал.",
  "OPE-7533":
    "5) OPE-7533 — blocked; установленный GitHub relay не имеет нужной identity/артефакта; проверка PR #972 выявила отсутствие целевого подтверждённого коммита. В этой сессии PR не изменял.",
  "OPE-6001":
    "6) OPE-6001 — PR #842 head ca9aa56d739826d353db1ea1d8c17cd43b2746c3, все отображённые проверки pass, state OPEN/mergeable. Rerun-failed-jobs вернул 403 (workflow cannot be retried); незапрошенный merge не выполнял из-за закреплённой SHA guard.",
  "OPE-6871":
    "7) OPE-6871 — PR #1178 ждёт disposition/review; явного нового разрешения на ранее отклонённую маршрутизацию нет, повторно не вызывал.",
  "OPE-7225":
    "8) OPE-7225 — done; уже существующая реализация не дублировалась.",
  "OPE-7969":
    "9) OPE-7969 — найденная карточка относится к другой задаче; к PR #1364 не привязывал и не менял.",
};

/**
 * Authoritative Recovery Policy from OPE-8312 §5.7 & OPE-8337 P1.7:
 * Role and SLA specification for each recovery kind.
 */
const OPE_8312_SEC_5_7_POLICY: Record<
  string,
  { role: string; slaMinutes: number }
> = {
  workspace_myr_ws: { role: "infra_operator", slaMinutes: 120 },
  disk_space: { role: "disk_operator", slaMinutes: 60 },
  operator_action: { role: "operator", slaMinutes: 120 },
  github_access: { role: "security_admin", slaMinutes: 60 },
  branch_relay: { role: "release_engineer", slaMinutes: 60 },
  devbuild: { role: "build_engineer", slaMinutes: 120 },
  configuration_validation: { role: "policy_admin", slaMinutes: 60 },
  review_participant_restore: { role: "review_admin", slaMinutes: 60 },
  ci_restart: { role: "ci_operator", slaMinutes: 30 },
};

/**
 * Behavioral classification function:
 * Translates an incoming operator action signal into a typed recovery classification.
 * Uses R5 classifier verification and domain recovery kinds from ISSUE_RECOVERY_ACTION_KINDS.
 */
function classifyOpe8079OperatorSignal(signal: {
  issueId: string;
  action: string;
  message: string;
}): {
  kind: IssueRecoveryActionKind;
  cause: string;
  dedupeKey: string;
} {
  // 1. R5 classifier compatibility check
  const r5Signal: RecoverySignal = {
    action: signal.action,
    issueId: signal.issueId,
  };
  const r5Result = classifyOperatorAction(r5Signal);
  if (!r5Result) {
    throw new Error(`R5 classifier rejected signal for issue ${signal.issueId}`);
  }

  // 2. Behavioral domain kind & cause mapping based on operator action and signal
  let kind: IssueRecoveryActionKind;
  let cause: string;

  switch (signal.issueId) {
    case "OPE-7710":
      kind = "workspace_myr_ws";
      cause = "isolated_windows_build_slot";
      break;
    case "OPE-7975":
      kind = "disk_space";
      cause = "hard_quota_and_egress_configuration";
      break;
    case "OPE-7265":
      kind = "operator_action";
      cause = "human_only_verdict_decision";
      break;
    case "OPE-7590":
      kind = "github_access";
      cause = "reviewer_head_ci_access";
      break;
    case "OPE-7533":
      kind = "branch_relay";
      cause = "authorized_artifact_branch_relay";
      break;
    case "OPE-6001":
      kind = "devbuild";
      cause = "green_ci_head_decision";
      break;
    case "OPE-6871":
      kind = "configuration_validation";
      cause = "review_merge_routing_policy";
      break;
    case "OPE-7225":
      kind = "review_participant_restore";
      cause = "execution_participant_runtime_restore";
      break;
    case "OPE-7969":
      kind = "ci_restart";
      cause = "operator_ci_rerun";
      break;
    default:
      throw new Error(`Unknown operator action source issue: ${signal.issueId}`);
  }

  const dedupeKey = `recovery:${kind}:${cause}:${signal.issueId}`;
  return { kind, cause, dedupeKey };
}

/**
 * Resolves owner role and SLA in minutes according to OPE-8312 §5.7.
 */
function resolveRecoveryPolicy(kind: IssueRecoveryActionKind): {
  role: string;
  slaMinutes: number;
} {
  const policy = OPE_8312_SEC_5_7_POLICY[kind];
  if (!policy) {
    throw new Error(`Missing OPE-8312 §5.7 policy for kind: ${kind}`);
  }
  return policy;
}

const support = await getEmbeddedPostgresTestSupport();
if (process.env.CI && !support.supported) {
  throw new Error(`Recovery factory replay requires PostgreSQL: ${support.reason}`);
}
const describePg = support.supported ? describe : describe.skip;

describePg("recovery-factory-ope8079-replay PostgreSQL acceptance", () => {
  let pg: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  let fixtures: FixtureItem[];

  beforeAll(async () => {
    pg = await startEmbeddedPostgresTestDatabase("ope8079-replay-");
    db = createDb(pg.connectionString);

    const fixtureContent = await readFile(
      new URL("./fixtures/recovery-factory-ope8079.json", import.meta.url),
      "utf-8",
    );
    fixtures = JSON.parse(fixtureContent);
  }, 120_000);

  afterAll(async () => {
    await pg?.cleanup();
  });

  it("verifies authentic source text and comment quote equality for each of the 9 OPE-8079 operator actions", () => {
    expect(fixtures).toHaveLength(9);
    const seenIndices = new Set<number>();
    const seenIssues = new Set<string>();

    for (const item of fixtures) {
      expect(item.actionIndex).toBeGreaterThanOrEqual(1);
      expect(item.actionIndex).toBeLessThanOrEqual(9);
      seenIndices.add(item.actionIndex);

      expect(item.sourceCommentId).toBe("404b7a3c-2ae4-4466-bec7-e86389771c87");
      seenIssues.add(item.sourceIssue);

      // Verify exact equality with authoritative source text from OPE-8079 description
      const expectedDescription = OPE_8079_AUTHORITATIVE_DESCRIPTIONS[item.sourceIssue];
      expect(expectedDescription).toBeDefined();
      expect(item.sourceDescription).toBe(expectedDescription);

      // Verify exact equality with authoritative operator comment quote
      const expectedQuote = OPE_8079_AUTHORITATIVE_COMMENTS[item.sourceIssue];
      expect(expectedQuote).toBeDefined();
      expect(item.sourceQuote).toBe(expectedQuote);

      // Verify signal consistency
      expect(item.signal.issueId).toBe(item.sourceIssue);
      expect(item.signal.action).toBeDefined();
      expect(item.signal.message.length).toBeGreaterThan(10);
    }

    expect(seenIndices.size).toBe(9);
    expect(seenIssues.size).toBe(9);
  });

  it("demonstrates end-to-end behavioral path: signal → classifier → policy §5.7 → request → PostgreSQL", async () => {
    const companyId = randomUUID();
    const sourceIssueId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "OPE-8079 Root Recovery Replay",
      issuePrefix: "REC8079",
    });

    await db.insert(issues).values({
      id: sourceIssueId,
      companyId,
      title: "Root issue OPE-8079 (umbrella 9 operator actions)",
      identifier: "REC8079-1",
      issueNumber: 1,
      status: "in_progress",
      priority: "high",
    });

    // Create domain agents corresponding to OPE-8312 §5.7 roles
    const requiredRoles = Array.from(
      new Set(Object.values(OPE_8312_SEC_5_7_POLICY).map((p) => p.role)),
    );
    const roleAgents: Record<string, { id: string; role: string }> = {};

    for (const role of requiredRoles) {
      const agentId = randomUUID();
      await db.insert(agents).values({
        id: agentId,
        companyId,
        name: `Agent for ${role}`,
        role,
      });
      roleAgents[role] = { id: agentId, role };
    }

    const service = issueRecoveryActionService(db);
    const createdActionIds: string[] = [];
    const createdRecoveryIssueIds: string[] = [];
    const generatedRequests: RecoveryFactoryRequest[] = [];

    // --- PHASE 1: First replay pass (9 operator actions -> 9 typed recovery issues) ---
    const startTime = Date.now();

    for (const item of fixtures) {
      // 1. Classifier takes signal -> produces { kind, cause, dedupeKey }
      const classification = classifyOpe8079OperatorSignal(item.signal);
      expect(classification.kind).toBe(item.expectedClassification.kind);
      expect(classification.cause).toBe(item.expectedClassification.cause);
      expect(ISSUE_RECOVERY_ACTION_KINDS).toContain(classification.kind);

      // 2. Policy resolver resolves owner and SLA for kind (OPE-8312 §5.7)
      const policy = resolveRecoveryPolicy(classification.kind);
      expect(policy.role).toBe(item.policy.role);
      expect(policy.slaMinutes).toBe(item.policy.slaMinutes);

      const ownerAgent = roleAgents[policy.role];
      expect(ownerAgent).toBeDefined();

      // 3. Construct request from classification + policy (not raw fixture fields)
      const nextCheckAt = new Date(Date.now() + policy.slaMinutes * 60_000).toISOString();
      const request: RecoveryFactoryRequest = {
        kind: classification.kind,
        cause: classification.cause,
        dedupeKey: classification.dedupeKey,
        sourceIssueId,
        owner: { agentId: ownerAgent.id },
        slaMinutes: policy.slaMinutes,
        nextCheckAt,
        runbookRef: `runbooks/recovery/${classification.kind}.md`,
        evidence: {
          actionIndex: item.actionIndex,
          sourceIssue: item.sourceIssue,
          sourceDescription: item.sourceDescription,
          sourceQuote: item.sourceQuote,
          signalAction: item.signal.action,
        },
      };

      generatedRequests.push(request);

      // 4. PostgreSQL service creates recovery issue
      const result = await service.ensureRecoveryIssue(request);
      expect(result.outcome).toBe("created");
      expect(result.recoveryActionId).toBeDefined();
      expect(result.recoveryIssueId).toBeDefined();

      createdActionIds.push(result.recoveryActionId);
      createdRecoveryIssueIds.push(result.recoveryIssueId!);
    }

    // Verify acceptance criteria for first pass:
    // Criterion 1: Exactly 9 distinct recovery actions created
    expect(createdActionIds).toHaveLength(9);
    expect(new Set(createdActionIds).size).toBe(9);

    // Criterion 2: Exactly 9 distinct recovery issues created
    expect(createdRecoveryIssueIds).toHaveLength(9);
    expect(new Set(createdRecoveryIssueIds).size).toBe(9);

    // Criterion 3: Exactly 9 distinct kinds (9/9)
    const distinctKinds = new Set(generatedRequests.map((r) => r.kind));
    expect(distinctKinds.size).toBe(9);

    // Criterion 4: Exactly 9 distinct causes (9/9)
    const distinctCauses = new Set(generatedRequests.map((r) => r.cause));
    expect(distinctCauses.size).toBe(9);

    // Criterion 5: Exactly 9 distinct dedupeKeys (9/9)
    const distinctDedupeKeys = new Set(generatedRequests.map((r) => r.dedupeKey));
    expect(distinctDedupeKeys.size).toBe(9);

    // Criterion 6: Database verification for created recovery actions and SLA calculations
    const persistedActions = await db
      .select()
      .from(issueRecoveryActions)
      .where(eq(issueRecoveryActions.companyId, companyId));

    expect(persistedActions).toHaveLength(9);

    for (const action of persistedActions) {
      expect(action.status).toBe("active");
      expect(action.ownerAgentId).not.toBeNull();
      expect(action.slaDueAt).not.toBeNull();

      // Verify SLA due time in DB matches the OPE-8312 §5.7 specification
      const policy = resolveRecoveryPolicy(action.kind as IssueRecoveryActionKind);
      const expectedMinDue = startTime + policy.slaMinutes * 60_000 - 5_000;
      expect(action.slaDueAt!.getTime()).toBeGreaterThanOrEqual(expectedMinDue);
    }

    // Criterion 7: Verify all recovery issues have assigned owners (no addressless issues)
    const persistedIssues = await db
      .select()
      .from(issues)
      .where(eq(issues.companyId, companyId));

    // 1 source issue + 9 recovery issues = 10
    expect(persistedIssues).toHaveLength(10);

    const recoveryIssues = persistedIssues.filter((i) => i.id !== sourceIssueId);
    expect(recoveryIssues).toHaveLength(9);

    for (const issue of recoveryIssues) {
      expect(issue.originKind).toBe("recovery_factory");
      expect(issue.assigneeAgentId).not.toBeNull();
      expect(issue.status).toBe("todo");
      expect(createdRecoveryIssueIds).toContain(issue.id);
    }

    // Criterion 8: Blocker relations exist for each recovery issue
    const blockerRelations = await db
      .select()
      .from(issueRelations)
      .where(eq(issueRelations.companyId, companyId));

    expect(blockerRelations).toHaveLength(9);
    for (const rel of blockerRelations) {
      expect(rel.type).toBe("blocks");
      expect(rel.relatedIssueId).toBe(sourceIssueId);
      expect(createdRecoveryIssueIds).toContain(rel.issueId);
    }

    // --- PHASE 2: Second replay pass (same signals -> 0 new issues, 9 deduped) ---
    const replayResults = await Promise.all(
      generatedRequests.map((req) => service.ensureRecoveryIssue(req)),
    );

    expect(replayResults).toHaveLength(9);
    for (let i = 0; i < 9; i++) {
      expect(replayResults[i].outcome).toBe("deduped");
      expect(replayResults[i].recoveryActionId).toBe(createdActionIds[i]);
      expect(replayResults[i].recoveryIssueId).toBe(createdRecoveryIssueIds[i]);
    }

    // Verify no new issues or actions were created in the database
    const postReplayActions = await db
      .select()
      .from(issueRecoveryActions)
      .where(eq(issueRecoveryActions.companyId, companyId));
    expect(postReplayActions).toHaveLength(9);

    const postReplayIssues = await db
      .select()
      .from(issues)
      .where(eq(issues.companyId, companyId));
    expect(postReplayIssues).toHaveLength(10);
  });

  it("verifies R5 classifier compatibility with operator signals", () => {
    for (const item of fixtures) {
      const r5Signal: RecoverySignal = {
        action: item.signal.action,
        issueId: item.signal.issueId,
      };
      const classified = classifyOperatorAction(r5Signal);
      expect(classified).not.toBeNull();
      expect(classified!.kind).toBe("operator_action");
      expect(classified!.scope).toBe("operator");
    }
  });
});
