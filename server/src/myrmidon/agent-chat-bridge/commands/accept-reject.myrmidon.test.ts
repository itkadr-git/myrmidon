/**
 * Tests for the Telegram DM commands /accept and /reject functionality.
 */

import { Mock, beforeEach, describe, expect, test, vi } from "vitest";
import { eq } from "drizzle-orm";
import { issueThreadInteractions } from "@paperclipai/db";
import type { IssueThreadInteraction } from "@paperclipai/shared";

import { runBridgedDirectMessageCommand } from "./index.js";
import { issueThreadInteractionService } from "../../../services/issue-thread-interactions.js";

// Mock the database and service
const mockDb = {
  select: vi.fn(),
  from: vi.fn(),
  where: vi.fn(),
  then: vi.fn(),
};

const mockService = {
  getForIssue: vi.fn(),
  acceptInteraction: vi.fn(),
  cancel: vi.fn(),
};

vi.mock("../../../services/issue-thread-interactions.js", () => ({
  issueThreadInteractionService: vi.fn().mockReturnValue(mockService),
}));

describe("Telegram DM Commands - Accept/Reject", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  test("/accept command with valid interaction ID", async () => {
    const mockInteraction: IssueThreadInteraction = {
      id: "test-interaction-id",
      issueId: "test-issue-id",
      companyId: "test-company-id",
      kind: "suggest_tasks",
      status: "pending",
      createdAt: new Date(),
      payload: {
        version: 1,
        tasks: [
          { clientKey: "task-1", parentClientKey: null, title: "Task 1", description: "Description 1", priority: "medium" },
          { clientKey: "task-2", parentClientKey: null, title: "Task 2", description: "Description 2", priority: "medium" },
        ],
      },
      title: "Test Card",
      summary: null,
      sourceRunId: null,
      continuationPolicy: "wake_assignee",
      addresseeUserId: null,
      createdById: "test-user-id",
      createdByIdType: "user",
      createdByAgentId: null,
      resolvedAt: null,
      resolvedByUserId: null,
      resolvedByAgentId: null,
      result: null,
    };

    mockService.getForIssue.mockResolvedValue(mockInteraction);
    mockService.acceptInteraction.mockResolvedValue({
      interaction: mockInteraction,
      createdIssues: [{ id: "new-task-1" }, { id: "new-task-2" }],
    });

    const result = await runBridgedDirectMessageCommand({
      db: mockDb as any,
      companyId: "test-company-id",
      agentId: "test-agent-id",
      endpointId: "test-endpoint-id",
      deliveryId: "test-delivery-id",
      boardUserId: "test-board-user-id",
      conversationIssueId: "test-issue-id",
      text: "/accept test-interaction-id",
      publicBaseUrl: "https://example.com",
      cancelRun: async () => {},
    });

    expect(result).toEqual({
      kind: "reply",
      command: "accept",
      text: "✅ Карточка принята!\n\nСоздан эпик: https://example.com/issues/test-issue-id\nКоличество задач: 2",
    });

    expect(mockService.getForIssue).toHaveBeenCalledWith(
      { id: "test-issue-id", companyId: "test-company-id" },
      "test-interaction-id"
    );

    expect(mockService.acceptInteraction).toHaveBeenCalledWith(
      { id: "test-issue-id", companyId: "test-company-id", projectId: null, goalId: null },
      "test-interaction-id",
      { selectedClientKeys: ["task-1", "task-2"] },
      { userId: "test-board-user-id", agentId: null }
    );
  });

  test("/accept command with invalid interaction ID", async () => {
    mockService.getForIssue.mockResolvedValue(null);

    const result = await runBridgedDirectMessageCommand({
      db: mockDb as any,
      companyId: "test-company-id",
      agentId: "test-agent-id",
      endpointId: "test-endpoint-id",
      deliveryId: "test-delivery-id",
      boardUserId: "test-board-user-id",
      conversationIssueId: "test-issue-id",
      text: "/accept invalid-id",
      publicBaseUrl: "https://example.com",
      cancelRun: async () => {},
    });

    expect(result).toEqual({
      kind: "reply",
      command: "accept",
      text: "Карточка с ID invalid-id не найдена",
    });
  });

  test("/accept command with non-pending interaction", async () => {
    const mockInteraction: IssueThreadInteraction = {
      id: "test-interaction-id",
      issueId: "test-issue-id",
      companyId: "test-company-id",
      kind: "suggest_tasks",
      status: "accepted",
      createdAt: new Date(),
      payload: {
        version: 1,
        tasks: [
          { clientKey: "task-1", parentClientKey: null, title: "Task 1", description: "Description 1", priority: "medium" },
        ],
      },
      title: "Test Card",
      summary: null,
      sourceRunId: null,
      continuationPolicy: "wake_assignee",
      addresseeUserId: null,
      createdById: "test-user-id",
      createdByIdType: "user",
      createdByAgentId: null,
      resolvedAt: null,
      resolvedByUserId: null,
      resolvedByAgentId: null,
      result: null,
    };

    mockService.getForIssue.mockResolvedValue(mockInteraction);

    const result = await runBridgedDirectMessageCommand({
      db: mockDb as any,
      companyId: "test-company-id",
      agentId: "test-agent-id",
      endpointId: "test-endpoint-id",
      deliveryId: "test-delivery-id",
      boardUserId: "test-board-user-id",
      conversationIssueId: "test-issue-id",
      text: "/accept test-interaction-id",
      publicBaseUrl: "https://example.com",
      cancelRun: async () => {},
    });

    expect(result).toEqual({
      kind: "reply",
      command: "accept",
      text: "Эта карточка не может быть принята или уже обработана",
    });
  });

  test("/reject command with valid interaction ID", async () => {
    const mockInteraction: IssueThreadInteraction = {
      id: "test-interaction-id",
      issueId: "test-issue-id",
      companyId: "test-company-id",
      kind: "suggest_tasks",
      status: "pending",
      createdAt: new Date(),
      payload: {
        version: 1,
        tasks: [
          { clientKey: "task-1", parentClientKey: null, title: "Task 1", description: "Description 1", priority: "medium" },
        ],
      },
      title: "Test Card",
      summary: null,
      sourceRunId: null,
      continuationPolicy: "wake_assignee",
      addresseeUserId: null,
      createdById: "test-user-id",
      createdByIdType: "user",
      createdByAgentId: null,
      resolvedAt: null,
      resolvedByUserId: null,
      resolvedByAgentId: null,
      result: null,
    };

    mockService.getForIssue.mockResolvedValue(mockInteraction);
    mockService.cancel.mockResolvedValue(mockInteraction);

    const result = await runBridgedDirectMessageCommand({
      db: mockDb as any,
      companyId: "test-company-id",
      agentId: "test-agent-id",
      endpointId: "test-endpoint-id",
      deliveryId: "test-delivery-id",
      boardUserId: "test-board-user-id",
      conversationIssueId: "test-issue-id",
      text: "/reject test-interaction-id",
      publicBaseUrl: "https://example.com",
      cancelRun: async () => {},
    });

    expect(result).toEqual({
      kind: "reply",
      command: "reject",
      text: "❌ Карточка отклонена.",
    });

    expect(mockService.getForIssue).toHaveBeenCalledWith(
      { id: "test-issue-id", companyId: "test-company-id" },
      "test-interaction-id"
    );

    expect(mockService.cancel).toHaveBeenCalledWith(
      { id: "test-issue-id", companyId: "test-company-id", projectId: null, goalId: null },
      "test-interaction-id",
      { reason: "rejected_by_owner_via_telegram" },
      { userId: "test-board-user-id", agentId: null }
    );
  });

  test("/reject command with non-pending interaction", async () => {
    const mockInteraction: IssueThreadInteraction = {
      id: "test-interaction-id",
      issueId: "test-issue-id",
      companyId: "test-company-id",
      kind: "suggest_tasks",
      status: "accepted",
      createdAt: new Date(),
      payload: {
        version: 1,
        tasks: [
          { clientKey: "task-1", parentClientKey: null, title: "Task 1", description: "Description 1", priority: "medium" },
        ],
      },
      title: "Test Card",
      summary: null,
      sourceRunId: null,
      continuationPolicy: "wake_assignee",
      addresseeUserId: null,
      createdById: "test-user-id",
      createdByIdType: "user",
      createdByAgentId: null,
      resolvedAt: null,
      resolvedByUserId: null,
      resolvedByAgentId: null,
      result: null,
    };

    mockService.getForIssue.mockResolvedValue(mockInteraction);

    const result = await runBridgedDirectMessageCommand({
      db: mockDb as any,
      companyId: "test-company-id",
      agentId: "test-agent-id",
      endpointId: "test-endpoint-id",
      deliveryId: "test-delivery-id",
      boardUserId: "test-board-user-id",
      conversationIssueId: "test-issue-id",
      text: "/reject test-interaction-id",
      publicBaseUrl: "https://example.com",
      cancelRun: async () => {},
    });

    expect(result).toEqual({
      kind: "reply",
      command: "reject",
      text: "Эта карточка уже обработана",
    });
  });

  test("/accept command with missing interaction ID", async () => {
    const result = await runBridgedDirectMessageCommand({
      db: mockDb as any,
      companyId: "test-company-id",
      agentId: "test-agent-id",
      endpointId: "test-endpoint-id",
      deliveryId: "test-delivery-id",
      boardUserId: "test-board-user-id",
      conversationIssueId: "test-issue-id",
      text: "/accept",
      publicBaseUrl: "https://example.com",
      cancelRun: async () => {},
    });

    expect(result).toEqual({
      kind: "reply",
      command: "accept",
      text: "Использование: /accept <id> — ID карточки для принятия",
    });
  });

  test("/reject command with missing interaction ID", async () => {
    const result = await runBridgedDirectMessageCommand({
      db: mockDb as any,
      companyId: "test-company-id",
      agentId: "test-agent-id",
      endpointId: "test-endpoint-id",
      deliveryId: "test-delivery-id",
      boardUserId: "test-board-user-id",
      conversationIssueId: "test-issue-id",
      text: "/reject",
      publicBaseUrl: "https://example.com",
      cancelRun: async () => {},
    });

    expect(result).toEqual({
      kind: "reply",
      command: "reject",
      text: "Использование: /reject <id> — ID карточки для отклонения",
    });
  });
});