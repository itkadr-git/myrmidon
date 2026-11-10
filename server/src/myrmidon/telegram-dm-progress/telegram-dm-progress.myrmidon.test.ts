import { beforeEach, describe, expect, it } from "vitest";
import {
  composeDmStatusText,
} from "../telegram-dm-status-progress.js";
import { dmProgressToolLabel, describeDmProgressTarget } from "./labels.js";
import {
  clearAllDmProgressRuntimeSteps,
  parseDmProgressLogLine,
  readDmProgressRuntimeSteps,
  recordDmProgressLogChunk,
  recordDmProgressRuntimeStatus,
} from "./runtime-steps.js";
import { decideDmStatusPublish, dmStatusStepKind } from "./throttle.js";
import {
  invalidateTelegramDmProgressSettingsCache,
  preserveTelegramDmProgressGeneralKey,
  readTelegramDmProgressSettings,
} from "./settings.js";

// myrmidon(DM-PROGRESS): composition, throttling and settings of the live
// progress steps in the bridged Telegram DM status message.

const AGENT = "Maya";
const T0 = new Date("2026-10-04T10:00:00Z");
const at = (sec: number) => new Date(T0.getTime() + sec * 1000);

describe("step labels", () => {
  it("names reads and edits in plain words with a safe target", () => {
    expect(dmProgressToolLabel({ toolName: "Read", preview: "/srv/files/deck.pptx" }).label).toBe(
      "читаю презентацию deck.pptx",
    );
    expect(dmProgressToolLabel({ toolName: "Edit", preview: "slides 4 and 9" }).label).toBe("правлю слайды 4, 9");
    expect(dmProgressToolLabel({ toolName: "Edit" }).label).toBe("правлю файл");
  });

  it("recognizes a check run in a shell command", () => {
    expect(dmProgressToolLabel({ toolName: "bash", preview: "pytest -q" })).toEqual({
      kind: "check",
      label: "проверяю результат",
    });
    expect(dmProgressToolLabel({ toolName: "bash", preview: "ls -la" }).label).toBe("выполняю команду");
  });

  it("never carries anything but a basename or slide numbers from a preview", () => {
    expect(describeDmProgressTarget("slides 4, 9 and then secret=hunter2")).toBe("слайды 4, 9");
    expect(describeDmProgressTarget("slides 4, 9 and then secret=hunter2", "en")).toBe("slides 4, 9");
    expect(describeDmProgressTarget("rm -rf everything")).toBeNull();
    expect(dmProgressToolLabel({ toolName: "weird tool!" }).label).toBe("инструмент: weirdtool");
    expect(dmProgressToolLabel({ toolName: "weird tool!", locale: "en" }).label).toBe("tool: weirdtool");
  });

  // myrmidon(1.7-TG-LOCALE): every step kind rendered in English.
  it("renders every step kind in English (TG-LOCALE)", () => {
    const cases: Array<[{ toolName: string; preview?: string }, { kind: string; label: string }]> = [
      [{ toolName: "read_file", preview: "draft.docx" }, { kind: "read", label: "reading document draft.docx" }],
      [{ toolName: "read_file" }, { kind: "read", label: "reading file" }],
      [{ toolName: "write_file", preview: "slides 1, 2" }, { kind: "edit", label: "editing slides 1, 2" }],
      [{ toolName: "write_file" }, { kind: "edit", label: "editing file" }],
      [{ toolName: "bash", preview: "pnpm test" }, { kind: "check", label: "checking the result" }],
      [{ toolName: "terminal", preview: "echo 1" }, { kind: "shell", label: "running a command" }],
      [{ toolName: "search_files", preview: "*.ts" }, { kind: "search_files", label: "searching files" }],
      [{ toolName: "vision", preview: "chart.png" }, { kind: "image", label: "looking at an image" }],
      [{ toolName: "web_search", preview: "myrmidon docs" }, { kind: "web_search", label: "searching the web" }],
      [{ toolName: "web_fetch", preview: "https://example.test" }, { kind: "web_page", label: "opening a page" }],
      [{ toolName: "delegate_task" }, { kind: "delegate", label: "spawning a helper" }],
      [{ toolName: "reasoning" }, { kind: "think", label: "thinking" }],
      [{ toolName: "update_plan" }, { kind: "plan", label: "planning" }],
      [{ toolName: "recall" }, { kind: "memory", label: "recalling context" }],
      [{ toolName: "mcp__crm__get_lead" }, { kind: "tool", label: "tool: mcp__crm__get_lead" }],
    ];
    for (const [input, expected] of cases) {
      expect(dmProgressToolLabel({ ...input, locale: "en" })).toEqual(expected);
    }
  });
});

describe("runtime step history", () => {
  beforeEach(() => clearAllDmProgressRuntimeSteps());

  it("parses Hermes tool lines", () => {
    expect(parseDmProgressLogLine("[tool] read_file /tmp/a/deck.pptx")).toEqual({
      type: "tool",
      toolName: "read_file",
      preview: "/tmp/a/deck.pptx",
    });
    expect(parseDmProgressLogLine("┊ 💭 thinking")).toEqual({ type: "think" });
    expect(parseDmProgressLogLine("plain output")).toBeNull();
  });

  it("records tool lines across chunks and keeps the richer label of one call", () => {
    recordDmProgressLogChunk("run1", "stdout", "[tool] read_file /tmp/deck.p", T0);
    recordDmProgressLogChunk("run1", "stdout", "ptx\n", T0);
    recordDmProgressRuntimeStatus({
      runId: "run1",
      message: "Running read_file",
      currentToolName: "read_file",
      lastAssistantSnippet: null,
      updatedAt: at(1),
    });
    const steps = readDmProgressRuntimeSteps("run1", at(2));
    expect(steps.map((step) => step.label)).toEqual(["читаю презентацию deck.pptx"]);
  });

  it("keeps a bounded history and ignores stderr", () => {
    for (let i = 0; i < 12; i += 1) {
      recordDmProgressLogChunk("run2", "stdout", `[tool] read_file f${i}.txt\n`, at(i));
    }
    recordDmProgressLogChunk("run2", "stderr", "[tool] bash x\n", at(13));
    const steps = readDmProgressRuntimeSteps("run2", at(14));
    expect(steps).toHaveLength(6);
    expect(steps.at(-1)?.label).toBe("читаю f11.txt");
  });
});

describe("composeDmStatusText", () => {
  const base = { agentName: AGENT, milestone: "working" as const, startedAt: T0, steps: [], now: at(100) };

  it("shows the current step, elapsed time and the last finished steps", () => {
    const text = composeDmStatusText({
      ...base,
      runtimeSteps: [{ label: "читаю презентацию deck.pptx" }, { label: "правлю слайды 4, 9" }],
    });
    const [head, ...rest] = text.split("\n");
    expect(head).toBe("Maya: правлю слайды 4, 9 · 1 мин");
    expect(rest.join("\n")).toContain("читаю презентацию deck.pptx");
  });

  it("falls back to 'работаю' without steps and with steps switched off", () => {
    expect(composeDmStatusText(base)).toBe("Maya: работаю · 1 мин");
    expect(composeDmStatusText({ ...base, runtimeSteps: [{ label: "думаю" }], showSteps: false })).toBe(
      "Maya: работаю · 1 мин",
    );
    expect(composeDmStatusText({ ...base, milestone: "queued" })).toBe("Maya: в очереди");
  });

  it("native run events win over the runtime history", () => {
    const text = composeDmStatusText({
      ...base,
      steps: [{ eventType: "research.started", message: null, createdAt: T0 }],
      runtimeSteps: [{ label: "думаю" }],
    });
    expect(text.split("\n")[0]).toContain("ищу информацию");
  });

  // myrmidon(1.7-TG-LOCALE): the English phases, elapsed units and steps;
  // a recorded step with structured facts renders per locale.
  it("renders the English phases, elapsed buckets and a re-rendered recorded step (TG-LOCALE)", () => {
    expect(composeDmStatusText({ ...base, milestone: "queued", locale: "en" })).toBe("Maya: queued");
    expect(composeDmStatusText({ ...base, locale: "en", now: at(50) })).toBe("Maya: working · <1 min");
    expect(composeDmStatusText({ ...base, locale: "en", now: at(3000) })).toBe("Maya: working · 50 min");
    expect(composeDmStatusText({ ...base, locale: "en", now: at(7320) })).toBe("Maya: working · 2 h 2 min");
    const text = composeDmStatusText({
      ...base,
      locale: "en",
      runtimeSteps: [{ kind: "read", toolName: "read_file", label: "читаю презентацию deck.pptx", target: { type: "document", noun: "pptx", basename: "deck.pptx" } }],
    });
    expect(text.split("\n")[0]).toBe("Maya: reading presentation deck.pptx · 1 min");
  });

  it("keeps the ru wording byte-identical to the pre-catalog status (TG-LOCALE)", () => {
    expect(composeDmStatusText(base)).toBe("Maya: работаю · 1 мин");
    expect(composeDmStatusText({ ...base, runtimeSteps: [{ kind: "read", toolName: "read_file", label: "читаю презентацию deck.pptx", target: { type: "document", noun: "pptx", basename: "deck.pptx" } }] })).toBe(
      "Maya: читаю презентацию deck.pptx · 1 мин",
    );
    expect(composeDmStatusText({ ...base, milestone: "queued" })).toBe("Maya: в очереди");
  });
});

describe("decideDmStatusPublish", () => {
  const common = { agentName: AGENT, intervalMs: 45_000 };
  const read = "Maya: читаю файл · 1 мин";

  it("posts the first status at once and never repeats identical text", () => {
    expect(
      decideDmStatusPublish({ ...common, previousText: null, previousMilestone: null, nextText: read, nextMilestone: "working", lastEditAt: null, now: at(0) }),
    ).toEqual({ publish: true, reason: "first" });
    expect(
      decideDmStatusPublish({ ...common, previousText: read, previousMilestone: "working", nextText: read, nextMilestone: "working", lastEditAt: at(0), now: at(500) }).publish,
    ).toBe(false);
  });

  it("queued to working publishes at once", () => {
    expect(
      decideDmStatusPublish({ ...common, previousText: "Maya: в очереди", previousMilestone: "queued", nextText: read, nextMilestone: "working", lastEditAt: at(0), now: at(1) }).reason,
    ).toBe("milestone_changed");
  });

  it("a new step kind waits for the short floor, a new target of the same kind for the interval", () => {
    const edit = "Maya: правлю слайды 4, 9 · 1 мин";
    const input = { ...common, previousText: read, previousMilestone: "working", nextText: edit, nextMilestone: "working" };
    expect(decideDmStatusPublish({ ...input, lastEditAt: at(0), now: at(2) }).reason).toBe("step_kind_floor");
    expect(decideDmStatusPublish({ ...input, lastEditAt: at(0), now: at(6) }).reason).toBe("step_kind_changed");

    const sameKind = { ...input, nextText: "Maya: читаю презентацию deck.pptx · 1 мин" };
    expect(decideDmStatusPublish({ ...sameKind, lastEditAt: at(0), now: at(30) }).reason).toBe("throttled");
    expect(decideDmStatusPublish({ ...sameKind, lastEditAt: at(0), now: at(46) }).reason).toBe("interval_elapsed");
  });

  it("derives the step kind from the headline without the elapsed suffix", () => {
    expect(dmStatusStepKind("Maya: правлю слайды 4, 9 · 3 мин\nРанее: …", AGENT)).toBe("правлю");
    expect(dmStatusStepKind("", AGENT)).toBeNull();
  });

  // myrmidon(1.7-TG-LOCALE): English time units are stripped like the Russian
  // ones — a minute-only suffix change is still the same step and stays
  // throttled instead of republishing every minute.
  it("does not publish an English edit when only the elapsed minutes change (TG-LOCALE)", () => {
    const before = "Maya: editing slides 4, 9 · 4 min";
    const afterMinute = "Maya: editing slides 4, 9 · 5 min";
    expect(dmStatusStepKind(before, AGENT)).toBe("editing");
    expect(dmStatusStepKind(afterMinute, AGENT)).toBe("editing");
    const input = {
      ...common,
      previousText: before,
      previousMilestone: "working" as const,
      nextText: afterMinute,
      nextMilestone: "working" as const,
      lastEditAt: at(0),
      now: at(30),
    };
    expect(decideDmStatusPublish(input).publish).toBe(false);
    expect(decideDmStatusPublish({ ...input, now: at(46) }).reason).toBe("interval_elapsed");
  });

  it("strips both the Russian and the English elapsed suffixes", () => {
    expect(dmStatusStepKind("Maya: running command · 2 h 5 min", AGENT)).toBe("running");
    expect(dmStatusStepKind("Maya: running command · 12 мин", AGENT)).toBe("running");
  });
});

describe("settings reader", () => {
  beforeEach(() => invalidateTelegramDmProgressSettingsCache());

  it("reads the stored value, caches it briefly, and applies a change after invalidation", async () => {
    let stored: unknown = { enabled: true, intervalSec: 60 };
    let reads = 0;
    const deps = {
      getGeneral: async () => {
        reads += 1;
        return { telegramDmProgress: stored };
      },
      env: {},
      now: () => 1_000,
    };
    expect((await readTelegramDmProgressSettings(deps)).intervalSec).toBe(60);
    stored = { enabled: false };
    expect((await readTelegramDmProgressSettings(deps)).intervalSec).toBe(60);
    expect(reads).toBe(1);
    invalidateTelegramDmProgressSettingsCache();
    expect(await readTelegramDmProgressSettings(deps)).toMatchObject({ enabled: false, intervalSec: 45 });
  });

  it("a failing read falls back to defaults instead of throwing", async () => {
    const result = await readTelegramDmProgressSettings({
      getGeneral: async () => {
        throw new Error("db down");
      },
      env: {},
    });
    expect(result.enabled).toBe(false);
  });

  it("preserve keeps the stored key across general writes", () => {
    expect(preserveTelegramDmProgressGeneralKey({ telegramDmProgress: { enabled: true } })).toEqual({
      telegramDmProgress: { enabled: true },
    });
    expect(preserveTelegramDmProgressGeneralKey({})).toEqual({});
  });
});
