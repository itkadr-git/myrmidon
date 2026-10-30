import { describe, expect, it } from "vitest";
import {
  checkIdeasWeeklySLA,
  isIdeasProjectName,
  validateIdeasProjectConstraints,
} from "./ideas.js";

describe("validateIdeasProjectConstraints", () => {
  it("recognizes 'Идеи' and 'Ideas' project names", () => {
    expect(isIdeasProjectName("Идеи")).toBe(true);
    expect(isIdeasProjectName("идеи")).toBe(true);
    expect(isIdeasProjectName(" Ideas ")).toBe(true);
    expect(isIdeasProjectName("Release 1.6.7")).toBe(false);
    expect(isIdeasProjectName(null)).toBe(false);
  });

  it("passes valid idea card without assignee and deadline, with origin in description", () => {
    const res = validateIdeasProjectConstraints({
      projectName: "Идеи",
      description: "Мысль Alex.\n\n**Откуда**:\n- Сессия: chat-123\n- Дата: 2026-10-28\n- Кто сказал: Alex",
    });
    expect(res.valid).toBe(true);
    expect(res.error).toBeUndefined();
  });

  it("passes valid idea card with origin in metadata", () => {
    const res = validateIdeasProjectConstraints({
      projectName: "Идеи",
      description: "Автоматический разбор",
      metadata: { origin: { session: "s1", date: "2026-10-28", author: "Alex" } },
    });
    expect(res.valid).toBe(true);
  });

  it("rejects idea card with assignee agent", () => {
    const res = validateIdeasProjectConstraints({
      projectName: "Идеи",
      assigneeAgentId: "agent-123",
      description: "Откуда: сессия Alex",
    });
    expect(res.valid).toBe(false);
    expect(res.error).toContain("без исполнителя");
  });

  it("rejects idea card with assignee user", () => {
    const res = validateIdeasProjectConstraints({
      projectName: "Идеи",
      assigneeUserId: "user-123",
      description: "Откуда: сессия Alex",
    });
    expect(res.valid).toBe(false);
    expect(res.error).toContain("без исполнителя");
  });

  it("rejects idea card with deadline", () => {
    const res = validateIdeasProjectConstraints({
      projectName: "Идеи",
      dueDate: "2026-11-01",
      description: "Откуда: сессия Alex",
    });
    expect(res.valid).toBe(false);
    expect(res.error).toContain("без срока");
  });

  it("rejects idea card without origin", () => {
    const res = validateIdeasProjectConstraints({
      projectName: "Идеи",
      description: "Просто текст идеи без указания откуда она взялась",
    });
    expect(res.valid).toBe(false);
    expect(res.error).toContain("«откуда»");

    const res2 = validateIdeasProjectConstraints({
      projectName: "Идеи",
      description: "Обычная мысль без источника",
    });
    expect(res2.valid).toBe(false);
    expect(res2.error).toContain("«откуда»");
  });

  it("accepts idea card with markdown header origin or structured session fields", () => {
    const res1 = validateIdeasProjectConstraints({
      projectName: "Идеи",
      description: "## Откуда\nВстреча 28.10",
    });
    expect(res1.valid).toBe(true);

    const res2 = validateIdeasProjectConstraints({
      projectName: "Идеи",
      description: "Мысль из звонка.\nСессия: chat-999\nДата: 2026-10-30\nКто сказал: Alex",
    });
    expect(res2.valid).toBe(true);
  });

  it("ignores non-ideas projects", () => {
    const res = validateIdeasProjectConstraints({
      projectName: "Выпуск 1.6.7",
      assigneeAgentId: "agent-123",
      dueDate: "2026-11-01",
      description: "Обычная задача",
    });
    expect(res.valid).toBe(true);
  });
});

describe("checkIdeasWeeklySLA", () => {
  const now = new Date("2026-10-28T12:00:00Z");

  it("marks cards younger than 7 days as compliant", () => {
    const issues = [
      { id: "i-1", status: "backlog", createdAt: "2026-10-25T10:00:00Z" }, // 3 days old
      { id: "i-2", status: "todo", createdAt: "2026-10-27T10:00:00Z" }, // 1 day old
    ];
    const res = checkIdeasWeeklySLA(issues, now);
    expect(res.total).toBe(2);
    expect(res.compliant).toBe(2);
    expect(res.staleCount).toBe(0);
    expect(res.staleIssueIds).toEqual([]);
  });

  it("marks completed/cancelled cards as compliant even if old", () => {
    const issues = [
      { id: "i-done", status: "done", createdAt: "2026-10-01T10:00:00Z" }, // 27 days old, but done
      { id: "i-cancel", status: "cancelled", createdAt: "2026-10-05T10:00:00Z" },
    ];
    const res = checkIdeasWeeklySLA(issues, now);
    expect(res.compliant).toBe(2);
    expect(res.staleCount).toBe(0);
  });

  it("detects unresolved cards older than 7 days as stale (SLA violation)", () => {
    const issues = [
      { id: "i-fresh", status: "backlog", createdAt: "2026-10-26T10:00:00Z" },
      { id: "i-stale", status: "backlog", createdAt: "2026-10-15T10:00:00Z" }, // 13 days old
    ];
    const res = checkIdeasWeeklySLA(issues, now);
    expect(res.total).toBe(2);
    expect(res.compliant).toBe(1);
    expect(res.staleCount).toBe(1);
    expect(res.staleIssueIds).toEqual(["i-stale"]);
  });
});
