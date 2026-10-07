// @vitest-environment jsdom
//
// myrmidon(1.7-AGENT-EXCHANGE-B): the owner-facing feed screen — the room
// rows (task link, participants, price tag), the «to skill» button and what
// the screen says once a room has a candidate: it waits for an approval.

import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentExchangeFeedResponse, AgentExchangeFeedRoom } from "@paperclipai/shared";
import { AgentExchangeFeedScreenView } from "./AgentExchangeFeedScreen";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  flushSync(() => root.unmount());
  container.remove();
});

function room(overrides: Partial<AgentExchangeFeedRoom> = {}): AgentExchangeFeedRoom {
  return {
    roomId: "11111111-1111-4111-8111-111111111111",
    issueId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    issueIdentifier: "OPE-4172",
    issueTitle: "1.7: AGENT-EXCHANGE B",
    status: "completed",
    stopReason: null,
    participants: [
      { label: "eng-1", model: "gpt-5" },
      { label: "eng-2", model: "claude-4" },
    ],
    currentRound: 3,
    maxRounds: 3,
    tokensUsed: 12_345,
    costCents: 1_250,
    costKnown: true,
    summaryDocumentKey: "exchange:11111111-1111-4111-8111-111111111111",
    summarized: true,
    skillCandidate: null,
    createdAt: "2026-10-07T06:10:00.000Z",
    closedAt: "2026-10-07T06:12:00.000Z",
    ...overrides,
  };
}

function feed(overrides: Partial<AgentExchangeFeedResponse> = {}): AgentExchangeFeedResponse {
  const rooms = overrides.rooms ?? [room()];
  return {
    rooms,
    totals: {
      rooms: rooms.length,
      summarizedRooms: rooms.filter((entry) => entry.summarized).length,
      candidateRooms: rooms.filter((entry) => entry.skillCandidate).length,
      tokensUsed: rooms.reduce((sum, entry) => sum + entry.tokensUsed, 0),
      costCents: rooms.reduce((sum, entry) => sum + entry.costCents, 0),
      costUnknownRooms: rooms.filter((entry) => !entry.costKnown).length,
    },
    limit: 50,
    truncated: false,
    skillCandidateEnabled: true,
    ...overrides,
  };
}

function render(value: AgentExchangeFeedResponse | null, onToSkill = vi.fn()) {
  flushSync(() => {
    root.render(
      // The rows link to the task and to the skill lifecycle screen, so the
      // view needs a router context.
      <MemoryRouter>
        <AgentExchangeFeedScreenView
          feed={value}
          loading={false}
          error={null}
          onToSkill={onToSkill}
          pendingRoomId={null}
          notice={null}
        />
      </MemoryRouter>,
    );
  });
  return onToSkill;
}

describe("AgentExchangeFeedScreenView", () => {
  it("shows the room with its task link, participants and price tag", () => {
    render(feed());
    const text = container.textContent ?? "";
    expect(text).toContain("Agent exchanges");
    expect(text).toContain("OPE-4172 — 1.7: AGENT-EXCHANGE B");
    expect(text).toContain("eng-1 (gpt-5), eng-2 (claude-4)");
    expect(text).toContain("completed · round 3/3");
    expect(text).toContain("12,345 tokens");
    expect(text).toContain("$0.1250");
    expect(text).toContain("exchange:11111111-1111-4111-8111-111111111111");
    expect(text).toContain("1 rooms · 1 with an outcome · 0 candidates");
  });

  it("says unknown instead of free when the price is not known", () => {
    render(feed({ rooms: [room({ costCents: 0, costKnown: false, tokensUsed: 900 })] }));
    expect(container.textContent).toContain("unknown (900 tokens)");
    expect(container.textContent).toContain("1 with an unknown price");
  });

  it("registers the outcome as a skill candidate when the button is pressed", () => {
    const onToSkill = render(feed());
    const button = container.querySelector<HTMLButtonElement>(
      '[data-testid="agent-exchange-feed-to-skill"]',
    );
    expect(button).not.toBeNull();
    expect(button!.textContent).toContain("To skill");
    flushSync(() => button!.click());
    expect(onToSkill).toHaveBeenCalledTimes(1);
    expect(onToSkill.mock.calls[0]![0].roomId).toBe(room().roomId);
  });

  it("waits for an approval once the room has a candidate", () => {
    render(
      feed({
        rooms: [
          room({
            skillCandidate: {
              skillId: "skill-1",
              key: "company/co-1/exchange-room-11111111-1111-4111-8111-111111111111",
              name: "Exchange room: OPE-4172",
              state: "candidate",
            },
          }),
        ],
      }),
    );
    const text = container.textContent ?? "";
    expect(text).toContain("Candidate skill: Exchange room: OPE-4172 — waiting for approval");
    expect(container.querySelector('[data-testid="agent-exchange-feed-to-skill"]')).toBeNull();
    expect(text).toContain("1 candidates");
  });

  it("offers no button for a room without an outcome", () => {
    render(feed({ rooms: [room({ summarized: false, summaryDocumentKey: null })] }));
    expect(container.textContent).toContain("No outcome yet");
    expect(container.querySelector('[data-testid="agent-exchange-feed-to-skill"]')).toBeNull();
  });

  it("hides the button when the settings switch it off", () => {
    render(feed({ skillCandidateEnabled: false }));
    expect(container.querySelector('[data-testid="agent-exchange-feed-to-skill"]')).toBeNull();
    expect(container.textContent).toContain("switched off in the feed settings");
  });

  it("explains an empty feed and a truncated one", () => {
    render(feed({ rooms: [], truncated: false }));
    expect(container.textContent).toContain("No discussion rooms yet");

    render(feed({ limit: 5, truncated: true }));
    expect(container.textContent).toContain("showing the newest 5");
  });
});