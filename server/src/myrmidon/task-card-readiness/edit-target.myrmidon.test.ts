import { describe, expect, it, vi } from "vitest";
import {
  EDIT_TARGET_MAX_PATHS,
  extractEditTargetPaths,
  TASK_CARD_EDIT_TARGET_CODES,
  verifyEditTargets,
  type FetchLike,
} from "./edit-target.js";
import {
  assertTaskCardReadyWithEditTargets,
  TASK_CARD_NOT_READY,
} from "./guard.js";

const VALID_CARD_WITH_TARGET = (target: string) => ({
  title: "1.6.7 TASK-CARD-READINESS-4: проверка места правки",
  description: `
МЕСТО ПРАВКИ: ${target}
НАМЕРЕНИЕ: Проверить существование пути на main ветке.
ГРАНИЦА ОБЪЁМА: Без кэша.
КРИТЕРИИ ПРИЁМКИ:
1. Ложно, если карточка с несуществующим путём разрешает переход.
ТЕСТ: Unit-тесты guard.
`,
});

function mockFetch(handler: (url: string, init?: RequestInit) => Response | Promise<Response>): FetchLike {
  return vi.fn(async (url: string, init?: RequestInit) => handler(url, init));
}

describe("extractEditTargetPaths", () => {
  it("extracts repository paths from the МЕСТО ПРАВКИ section", () => {
    const card = `
МЕСТО ПРАВКИ: расширение server/src/myrmidon/task-card-readiness/guard.ts (модуль слайса 2); сетевой слой — server/src/services/github-fetch.ts.
НАМЕРЕНИЕ: парсер путей.
ГРАНИЦА ОБЪЁМА: без UI.
КРИТЕРИИ ПРИЁМКИ: Ложно, если 422.
ТЕСТ: unit-тесты.
`;
    const paths = extractEditTargetPaths(card);
    expect(paths.map((p) => p.path)).toEqual([
      "server/src/myrmidon/task-card-readiness/guard.ts",
      "server/src/services/github-fetch.ts",
    ]);
    expect(paths.every((p) => !p.isNew)).toBe(true);
  });

  it("marks paths marked as new file / новый файл", () => {
    const card = `
МЕСТО ПРАВКИ:
- server/src/existing.ts — существующий файл
- server/src/new-module.ts (новый файл)
- packages/shared/src/types.ts — new file
НАМЕРЕНИЕ: тест
ГРАНИЦА ОБЪЁМА: тест
КРИТЕРИИ ПРИЁМКИ: Ложно, если что-то сломалось.
ТЕСТ: тест
`;
    const paths = extractEditTargetPaths(card);
    const byPath = Object.fromEntries(paths.map((p) => [p.path, p.isNew]));
    expect(byPath["server/src/existing.ts"]).toBe(false);
    expect(byPath["server/src/new-module.ts"]).toBe(true);
    expect(byPath["packages/shared/src/types.ts"]).toBe(true);
  });

  it("ignores URLs and stops at the next section heading", () => {
    const card = `
МЕСТО ПРАВКИ: src/valid/path.ts и ссылка https://github.com/itkadr-git/myrmidon/blob/main/doc/SPEC.md
НАМЕРЕНИЕ: путь в другой секции server/src/ignored.ts не должен парситься.
`;
    const paths = extractEditTargetPaths(card);
    expect(paths.map((p) => p.path)).toEqual(["src/valid/path.ts"]);
  });

  it("returns an empty array when МЕСТО ПРАВКИ is absent or card is empty", () => {
    expect(extractEditTargetPaths("")).toEqual([]);
    expect(extractEditTargetPaths(null)).toEqual([]);
    expect(extractEditTargetPaths("НАМЕРЕНИЕ: что-то другое")).toEqual([]);
  });
});

describe("verifyEditTargets", () => {
  it("resolves successfully when path exists on default branch (200 OK)", async () => {
    const fetchImpl = mockFetch((url) => {
      expect(url).toContain("raw.githubusercontent.com/itkadr-git/myrmidon/main/server/src/guard.ts");
      return new Response("", { status: 200 });
    });

    const result = await verifyEditTargets({
      paths: [{ path: "server/src/guard.ts", isNew: false, line: "guard" }],
      repository: "itkadr-git/myrmidon",
      defaultBranch: "main",
      fetch: fetchImpl,
    });

    expect(result.violations).toEqual([]);
    expect(result.checked).toEqual(["server/src/guard.ts"]);
    expect(result.skipped).toEqual([]);
  });

  it("returns EDIT_TARGET_NOT_FOUND when path does not exist (404/410)", async () => {
    const fetchImpl = mockFetch(() => new Response("", { status: 404 }));

    const result = await verifyEditTargets({
      paths: [{ path: "skills/nope/SKILL.md", isNew: false, line: "skills/nope/SKILL.md" }],
      repository: "itkadr-git/myrmidon",
      defaultBranch: "main",
      fetch: fetchImpl,
    });

    expect(result.violations).toHaveLength(1);
    expect(result.violations[0]?.code).toBe(TASK_CARD_EDIT_TARGET_CODES.EDIT_TARGET_NOT_FOUND);
    expect(result.violations[0]?.severity).toBe("error");
    expect(result.violations[0]?.path).toBe("skills/nope/SKILL.md");
  });

  it("does not probe paths marked as new files", async () => {
    const fetchImpl = vi.fn();

    const result = await verifyEditTargets({
      paths: [{ path: "server/src/new-file.ts", isNew: true, line: "new file" }],
      repository: "itkadr-git/myrmidon",
      defaultBranch: "main",
      fetch: fetchImpl,
    });

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(result.violations).toEqual([]);
    expect(result.skipped).toEqual(["server/src/new-file.ts"]);
  });

  it("fails open (warning, no blocking error) on network/connection failure", async () => {
    const fetchImpl = mockFetch(() => {
      throw new Error("Network unreachable");
    });

    const result = await verifyEditTargets({
      paths: [{ path: "server/src/guard.ts", isNew: false, line: "guard" }],
      repository: "itkadr-git/myrmidon",
      defaultBranch: "main",
      fetch: fetchImpl,
    });

    // Zero blocking violations, warning recorded in allViolations
    expect(result.violations).toEqual([]);
    expect(result.allViolations).toHaveLength(1);
    expect(result.allViolations[0]?.code).toBe(TASK_CARD_EDIT_TARGET_CODES.EDIT_TARGET_UNVERIFIED);
    expect(result.allViolations[0]?.severity).toBe("warning");
  });

  it("fails open (warning, no blocking error) when credentials are unavailable or absent", async () => {
    const fetchImpl = vi.fn();

    const result = await verifyEditTargets({
      paths: [{ path: "server/src/guard.ts", isNew: false, line: "guard" }],
      repository: "itkadr-git/myrmidon",
      credentials: { status: "unavailable", reason: "no identity connected" },
      fetch: fetchImpl,
    });

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(result.violations).toEqual([]);
    expect(result.allViolations).toHaveLength(1);
    expect(result.allViolations[0]?.severity).toBe("warning");
  });

  it("fails open (warning) when no repository is connected", async () => {
    const result = await verifyEditTargets({
      paths: [{ path: "server/src/guard.ts", isNew: false, line: "guard" }],
      repository: null,
    });

    expect(result.violations).toEqual([]);
    expect(result.allViolations).toHaveLength(1);
    expect(result.allViolations[0]?.code).toBe(TASK_CARD_EDIT_TARGET_CODES.EDIT_TARGET_UNVERIFIED);
  });
});

describe("assertTaskCardReadyWithEditTargets (end-to-end acceptance criteria)", () => {
  it("criterion 1: card names non-existent path -> 422 with EDIT_TARGET_NOT_FOUND in enforce mode", async () => {
    const card = VALID_CARD_WITH_TARGET("skills/nope/SKILL.md");
    const fetchImpl = mockFetch(() => new Response("", { status: 404 }));

    await expect(
      assertTaskCardReadyWithEditTargets(card, {
        forceEnforce: true,
        editTargets: {
          repository: "itkadr-git/myrmidon",
          defaultBranch: "main",
          fetch: fetchImpl,
        },
      }),
    ).rejects.toMatchObject({
      status: 422,
      details: {
        code: TASK_CARD_NOT_READY,
        violations: expect.arrayContaining([
          expect.objectContaining({
            code: TASK_CARD_EDIT_TARGET_CODES.EDIT_TARGET_NOT_FOUND,
            path: "skills/nope/SKILL.md",
          }),
        ]),
      },
    });
  });

  it("criterion 2: path marked 'новый файл' does not block transition", async () => {
    const card = VALID_CARD_WITH_TARGET("server/src/brand-new.ts (новый файл)");
    const fetchImpl = vi.fn(); // Must not even be called

    await expect(
      assertTaskCardReadyWithEditTargets(card, {
        forceEnforce: true,
        editTargets: {
          repository: "itkadr-git/myrmidon",
          defaultBranch: "main",
          fetch: fetchImpl,
        },
      }),
    ).resolves.toBeUndefined();

    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("criterion 3: unreachable network -> transition allowed (fail-open)", async () => {
    const card = VALID_CARD_WITH_TARGET("server/src/guard.ts");
    const fetchImpl = mockFetch(() => {
      throw new Error("DNS lookup failed");
    });

    await expect(
      assertTaskCardReadyWithEditTargets(card, {
        forceEnforce: true,
        editTargets: {
          repository: "itkadr-git/myrmidon",
          defaultBranch: "main",
          fetch: fetchImpl,
        },
      }),
    ).resolves.toBeUndefined();
  });

  it("criterion 3: no GitHub connection -> transition allowed (fail-open)", async () => {
    const card = VALID_CARD_WITH_TARGET("server/src/guard.ts");

    await expect(
      assertTaskCardReadyWithEditTargets(card, {
        forceEnforce: true,
        editTargets: {
          repository: null,
          credentials: { status: "absent" },
        },
      }),
    ).resolves.toBeUndefined();
  });

  it("passes when path actually exists", async () => {
    const card = VALID_CARD_WITH_TARGET("server/src/guard.ts");
    const fetchImpl = mockFetch(() => new Response("OK", { status: 200 }));

    await expect(
      assertTaskCardReadyWithEditTargets(card, {
        forceEnforce: true,
        editTargets: {
          repository: "itkadr-git/myrmidon",
          defaultBranch: "main",
          fetch: fetchImpl,
        },
      }),
    ).resolves.toBeUndefined();
  });
});
