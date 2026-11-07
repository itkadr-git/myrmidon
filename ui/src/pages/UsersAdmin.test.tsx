// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BreadcrumbProvider } from "@/context/BreadcrumbContext";
import { UsersAdmin } from "./UsersAdmin";

const mocks = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
  patch: vi.fn(),
  delete: vi.fn(),
}));

vi.mock("@/api/client", () => ({
  api: mocks,
  ApiError: class extends Error {
    constructor(
      message: string,
      public status: number,
      public data: unknown = {}
    ) {
      super(message);
    }
  },
}));

const mockActiveUser = {
  id: "user-1",
  username: "alice",
  email: "alice@example.com",
  name: "Alice Smith",
  role: "member" as const,
  blocked: false,
  syntheticEmail: false,
  createdAt: "2026-10-01T12:00:00.000Z",
};

const mockBlockedUser = {
  id: "user-2",
  username: "bob",
  email: "bob@example.com",
  name: "Bob Jones",
  role: "member" as const,
  blocked: true,
  syntheticEmail: false,
  createdAt: "2026-10-02T12:00:00.000Z",
};

function setInputValue(input: HTMLInputElement, value: string) {
  const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
    window.HTMLInputElement.prototype,
    "value"
  )?.set;
  nativeInputValueSetter?.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
  input.dispatchEvent(new Event("change", { bubbles: true }));
}

describe("UsersAdmin confirmation dialogs", () => {
  let container: HTMLDivElement;
  let root: Root;
  let client: QueryClient;

  async function eventually(assertion: () => void | Promise<void>) {
    await vi.waitFor(async () => {
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
      await assertion();
    });
  }

  beforeEach(() => {
    vi.resetAllMocks();
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

    mocks.get.mockImplementation(async (path: string) => {
      if (path === "/myrmidon/users-admin-a/users") {
        return {
          users: [mockActiveUser, mockBlockedUser],
          total: 2,
        };
      }
      if (path === "/myrmidon/users-admin-a/audit") {
        return {
          audit: [],
          total: 0,
        };
      }
      return {};
    });

    client = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
        mutations: { retry: false },
      },
    });

    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    client.clear();
    container.remove();
    document.body.innerHTML = "";
  });

  async function renderPage() {
    await act(async () => {
      root.render(
        <QueryClientProvider client={client}>
          <BreadcrumbProvider>
            <UsersAdmin />
          </BreadcrumbProvider>
        </QueryClientProvider>
      );
    });
    // Wait for initial queries to settle
    await eventually(() => {
      expect(container.querySelector('[data-testid="user-block-toggle-user-1"]')).not.toBeNull();
    });
  }

  it("opens confirmation dialog when clicking block on an active user and cancels cleanly", async () => {
    await renderPage();

    const blockBtn = container.querySelector<HTMLButtonElement>('[data-testid="user-block-toggle-user-1"]')!;
    expect(blockBtn).toBeDefined();

    await act(async () => {
      blockBtn.click();
    });

    await eventually(() => {
      const dialog = document.querySelector('[data-testid="confirm-block-dialog"]');
      expect(dialog).not.toBeNull();
      expect(dialog?.textContent).toContain("Alice Smith");
      expect(dialog?.textContent).toContain("alice");
    });

    const cancelBtn = document.querySelector<HTMLButtonElement>('[data-testid="confirm-dialog-cancel"]')!;
    expect(cancelBtn).toBeDefined();

    await act(async () => {
      cancelBtn.click();
    });

    await eventually(() => {
      expect(document.querySelector('[data-testid="confirm-block-dialog"]')).toBeNull();
    });
    expect(mocks.patch).not.toHaveBeenCalled();
  });

  it("submits block mutation with optional reason and closes dialog on success", async () => {
    mocks.patch.mockResolvedValueOnce({
      user: { ...mockActiveUser, blocked: true },
    });

    await renderPage();

    const blockBtn = container.querySelector<HTMLButtonElement>('[data-testid="user-block-toggle-user-1"]')!;
    await act(async () => {
      blockBtn.click();
    });

    await eventually(() => {
      expect(document.querySelector('[data-testid="confirm-block-dialog"]')).not.toBeNull();
    });

    const reasonInput = document.querySelector<HTMLInputElement>('[data-testid="confirm-block-reason"]')!;
    expect(reasonInput).toBeDefined();

    await act(async () => {
      setInputValue(reasonInput, "Security violation");
    });

    const submitBtn = document.querySelector<HTMLButtonElement>('[data-testid="confirm-block-submit"]')!;
    await act(async () => {
      submitBtn.click();
    });

    await eventually(() => {
      expect(mocks.patch).toHaveBeenCalledWith(
        "/myrmidon/users-admin-a/users/user-1",
        { blocked: true, reason: "Security violation" }
      );
    });

    await eventually(() => {
      expect(document.querySelector('[data-testid="confirm-block-dialog"]')).toBeNull();
    });
  });

  it("submits block mutation without reason when input is empty", async () => {
    mocks.patch.mockResolvedValueOnce({
      user: { ...mockActiveUser, blocked: true },
    });

    await renderPage();

    const blockBtn = container.querySelector<HTMLButtonElement>('[data-testid="user-block-toggle-user-1"]')!;
    await act(async () => {
      blockBtn.click();
    });

    await eventually(() => {
      expect(document.querySelector('[data-testid="confirm-block-dialog"]')).not.toBeNull();
    });

    const submitBtn = document.querySelector<HTMLButtonElement>('[data-testid="confirm-block-submit"]')!;
    await act(async () => {
      submitBtn.click();
    });

    await eventually(() => {
      expect(mocks.patch).toHaveBeenCalledWith(
        "/myrmidon/users-admin-a/users/user-1",
        { blocked: true }
      );
    });
  });

  it("unblocks directly without confirmation dialog when user is already blocked", async () => {
    mocks.patch.mockResolvedValueOnce({
      user: { ...mockBlockedUser, blocked: false },
    });

    await renderPage();

    const unblockBtn = container.querySelector<HTMLButtonElement>('[data-testid="user-block-toggle-user-2"]')!;
    expect(unblockBtn).toBeDefined();

    await act(async () => {
      unblockBtn.click();
    });

    await eventually(() => {
      expect(mocks.patch).toHaveBeenCalledWith(
        "/myrmidon/users-admin-a/users/user-2",
        { blocked: false }
      );
    });
    expect(document.querySelector('[data-testid="confirm-block-dialog"]')).toBeNull();
  });

  it("opens reset password confirmation dialog, cancels cleanly, and submits on confirm", async () => {
    mocks.patch.mockResolvedValueOnce({
      passwordSetLink: "http://localhost:3100/set-password?token=abc-123",
    });

    await renderPage();

    const resetBtn = container.querySelector<HTMLButtonElement>('[data-testid="user-reset-password-user-1"]')!;
    expect(resetBtn).toBeDefined();

    await act(async () => {
      resetBtn.click();
    });

    await eventually(() => {
      const dialog = document.querySelector('[data-testid="confirm-reset-dialog"]');
      expect(dialog).not.toBeNull();
      expect(dialog?.textContent).toContain("Alice Smith");
      expect(dialog?.textContent).toContain("alice");
    });

    // Cancel first
    const cancelBtn = document.querySelector<HTMLButtonElement>('[data-testid="confirm-dialog-cancel"]')!;
    await act(async () => {
      cancelBtn.click();
    });

    await eventually(() => {
      expect(document.querySelector('[data-testid="confirm-reset-dialog"]')).toBeNull();
    });
    expect(mocks.patch).not.toHaveBeenCalled();

    // Re-open and confirm
    await act(async () => {
      resetBtn.click();
    });

    await eventually(() => {
      expect(document.querySelector('[data-testid="confirm-reset-dialog"]')).not.toBeNull();
    });

    const submitBtn = document.querySelector<HTMLButtonElement>('[data-testid="confirm-reset-submit"]')!;
    await act(async () => {
      submitBtn.click();
    });

    await eventually(() => {
      expect(mocks.patch).toHaveBeenCalledWith(
        "/myrmidon/users-admin-a/users/user-1",
        { resetPassword: true }
      );
    });

    await eventually(() => {
      expect(document.querySelector('[data-testid="confirm-reset-dialog"]')).toBeNull();
      expect(container.textContent).toContain("http://localhost:3100/set-password?token=abc-123");
    });
  });

  it("displays error message inside dialog when mutation fails", async () => {
    mocks.patch.mockRejectedValueOnce(new Error("Database connection error"));

    await renderPage();

    const blockBtn = container.querySelector<HTMLButtonElement>('[data-testid="user-block-toggle-user-1"]')!;
    await act(async () => {
      blockBtn.click();
    });

    await eventually(() => {
      expect(document.querySelector('[data-testid="confirm-block-dialog"]')).not.toBeNull();
    });

    const submitBtn = document.querySelector<HTMLButtonElement>('[data-testid="confirm-block-submit"]')!;
    await act(async () => {
      submitBtn.click();
    });

    await eventually(() => {
      const errorMsg = document.querySelector('[data-testid="confirm-dialog-error"]');
      expect(errorMsg).not.toBeNull();
      expect(errorMsg?.textContent).toContain("Database connection error");
    });

    // Dialog stays open so user sees the error
    expect(document.querySelector('[data-testid="confirm-block-dialog"]')).not.toBeNull();
  });
});
