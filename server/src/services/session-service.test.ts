import { describe, expect, it, vi } from "vitest";
import { authSessions, boardApiKeys } from "@myrmidon/db";
import { revokeAllUserSessions, sessionService } from "./session-service.js";

describe("revokeAllUserSessions", () => {
  it("deletes Better Auth sessions and revokes active board API keys", async () => {
    const deleted = vi.fn().mockReturnValue({
      where: vi.fn().mockReturnValue({
        returning: vi.fn().mockResolvedValue([{ id: "session-1" }]),
      }),
    });
    const update = vi.fn().mockReturnValue({
      set: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([{ id: "key-1" }]),
        }),
      }),
    });
    const db = { delete: deleted, update } as never;

    await expect(revokeAllUserSessions("user-1", db)).resolves.toEqual({
      sessionsRevoked: 1,
      apiKeysRevoked: 1,
    });
    expect(deleted).toHaveBeenCalledWith(authSessions);
    expect(update).toHaveBeenCalledWith(boardApiKeys);
  });

  it("does not revoke anything for a non-suspended update unless called", async () => {
    const deleted = vi.fn();
    const update = vi.fn();
    const service = sessionService({ delete: deleted, update } as never);

    expect(service.revokeAllUserSessions).toBeTypeOf("function");
    expect(deleted).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
  });
});
