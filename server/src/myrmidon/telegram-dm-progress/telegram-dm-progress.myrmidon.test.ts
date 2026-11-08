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
    expect(describeDmProgressTarget("rm -rf everything")).toBeNull();
    expect(dmProgressToolLabel({ toolName: "weird tool!" }).label).toBe("инструмент: weirdtool");
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
