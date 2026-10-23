// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sanitizeAssetNamespace } from "@paperclipai/shared";
import { AuthApiError } from "@/api/auth";
import { ProfileSettings } from "./ProfileSettings";

const mockAuthApi = vi.hoisted(() => ({
  getSession: vi.fn(),
  signInEmail: vi.fn(),
  signUpEmail: vi.fn(),
  getProfile: vi.fn(),
  updateProfile: vi.fn(),
  signOut: vi.fn(),
  listAccounts: vi.fn(),
  changePassword: vi.fn(),
}));

const mockAssetsApi = vi.hoisted(() => ({
  uploadImage: vi.fn(),
  uploadCompanyLogo: vi.fn(),
}));

const mockSetBreadcrumbs = vi.hoisted(() => vi.fn());

vi.mock("@/api/auth", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/api/auth")>()),
  authApi: mockAuthApi,
}));

vi.mock("@/api/assets", () => ({
  assetsApi: mockAssetsApi,
}));

vi.mock("../context/BreadcrumbContext", () => ({
  useBreadcrumbs: () => ({
    setBreadcrumbs: mockSetBreadcrumbs,
  }),
}));

vi.mock("../context/CompanyContext", () => ({
  useCompany: () => ({
    selectedCompanyId: "company-1",
    selectedCompany: { id: "company-1", name: "Paperclip", issuePrefix: "PAP" },
  }),
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

async function flushReact() {
  await act(async () => {
    await Promise.resolve();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  });
}

describe("ProfileSettings", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);

    mockAuthApi.getSession.mockResolvedValue({
      session: { id: "session-1", userId: "user-1" },
      user: {
        id: "user-1",
        name: "Jane Example",
        email: "jane@example.com",
        image: "https://example.com/jane.png",
      },
    });
    mockAuthApi.listAccounts.mockResolvedValue([{ providerId: "credential" }]);
    mockAuthApi.changePassword.mockResolvedValue(undefined);
    mockAssetsApi.uploadImage.mockResolvedValue({
      assetId: "asset-1",
      contentPath: "/api/assets/asset-1/content",
    });
    mockAuthApi.updateProfile.mockImplementation(async (input: { name: string; image: string | null }) => ({
      id: "user-1",
      name: input.name,
      email: "jane@example.com",
      image: input.image,
    }));
  });

  afterEach(() => {
    container.remove();
    document.body.innerHTML = "";
    vi.clearAllMocks();
  });

  it("uploads a clicked avatar into Paperclip storage and persists the returned asset path", async () => {
    const root = createRoot(container);
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });

    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <ProfileSettings />
        </QueryClientProvider>,
      );
    });
    await flushReact();
    await flushReact();

    expect(container.textContent).not.toContain("Avatar image URL");

    const avatarInput = container.querySelector('input[type="file"]') as HTMLInputElement | null;
    expect(avatarInput).not.toBeNull();

    const file = new File(["avatar"], "avatar.png", { type: "image/png" });
    Object.defineProperty(avatarInput, "files", {
      configurable: true,
      value: [file],
    });

    await act(async () => {
      avatarInput?.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await flushReact();
    await flushReact();

    expect(mockAssetsApi.uploadImage).toHaveBeenCalledWith("company-1", file, "profiles/user-1");
    expect(mockAuthApi.updateProfile).toHaveBeenCalledWith({
      name: "Jane Example",
      image: "/api/assets/asset-1/content",
    });

    await act(async () => {
      root.unmount();
    });
  });

  it("uploads an avatar for a user id that comes from an identity provider", async () => {
    const userId = "oidc:example|jane.example@example.com";
    mockAuthApi.getSession.mockResolvedValue({
      session: { id: "session-1", userId },
      user: {
        id: userId,
        name: "Jane Example",
        email: "jane@example.com",
        image: "https://example.com/jane.png",
      },
    });

    const root = createRoot(container);
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });

    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <ProfileSettings />
        </QueryClientProvider>,
      );
    });
    await flushReact();
    await flushReact();

    const avatarInput = container.querySelector('input[type="file"]') as HTMLInputElement | null;
    expect(avatarInput).not.toBeNull();

    const file = new File(["avatar"], "avatar.png", { type: "image/png" });
    Object.defineProperty(avatarInput, "files", {
      configurable: true,
      value: [file],
    });

    await act(async () => {
      avatarInput?.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await flushReact();
    await flushReact();

    const namespace = `profiles/${userId}`;
    expect(mockAssetsApi.uploadImage).toHaveBeenCalledWith("company-1", file, namespace);
    // The namespace goes to the API without a change, so the avatar arrives
    // under the identity of the user.
    expect(sanitizeAssetNamespace(namespace)).toBe(namespace);
    expect(mockAuthApi.updateProfile).toHaveBeenCalledWith({
      name: "Jane Example",
      image: "/api/assets/asset-1/content",
    });

    await act(async () => {
      root.unmount();
    });
  });
  async function renderProfile() {
    const root = createRoot(container);
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <ProfileSettings />
        </QueryClientProvider>,
      );
    });
    await flushReact();
    await flushReact();
    return root;
  }

  async function typeInto(id: string, value: string) {
    const input = container.querySelector(`#${id}`) as HTMLInputElement;
    expect(input).not.toBeNull();
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    await act(async () => {
      setter.call(input, value);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
  }

  async function submitPasswordForm() {
    const form = container.querySelector('[data-testid="change-password-form"]') as HTMLFormElement;
    await act(async () => {
      form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });
    await flushReact();
  }

  it("changes the password and can sign out other devices", async () => {
    const root = await renderProfile();
    await typeInto("profile-current-password", "old-password");
    await typeInto("profile-new-password", "new-password-1");
    await typeInto("profile-confirm-password", "new-password-1");
    const revoke = container.querySelector("#profile-revoke-other-sessions") as HTMLInputElement;
    await act(async () => {
      revoke.click();
    });
    await submitPasswordForm();

    expect(mockAuthApi.changePassword).toHaveBeenCalledWith({
      currentPassword: "old-password",
      newPassword: "new-password-1",
      revokeOtherSessions: true,
    });
    expect(container.querySelector('[role="status"]')).not.toBeNull();
    expect(container.querySelector('[role="alert"]')).toBeNull();

    await act(async () => {
      root.unmount();
    });
  });

  it("rejects a repeat that does not match without calling the server", async () => {
    const root = await renderProfile();
    await typeInto("profile-current-password", "old-password");
    await typeInto("profile-new-password", "new-password-1");
    await typeInto("profile-confirm-password", "new-password-2");
    await submitPasswordForm();

    expect(mockAuthApi.changePassword).not.toHaveBeenCalled();
    expect(container.querySelector('[role="alert"]')).not.toBeNull();

    await act(async () => {
      root.unmount();
    });
  });

  it("rejects a too-short new password without calling the server", async () => {
    const root = await renderProfile();
    await typeInto("profile-current-password", "old-password");
    await typeInto("profile-new-password", "short");
    await typeInto("profile-confirm-password", "short");
    await submitPasswordForm();

    expect(mockAuthApi.changePassword).not.toHaveBeenCalled();
    expect(container.querySelector('[role="alert"]')).not.toBeNull();

    await act(async () => {
      root.unmount();
    });
  });

  it("shows a server error for a wrong current password", async () => {
    mockAuthApi.changePassword.mockRejectedValue(
      new AuthApiError("Invalid password", 400, { code: "INVALID_PASSWORD" }, "INVALID_PASSWORD"),
    );
    const root = await renderProfile();
    await typeInto("profile-current-password", "wrong-password");
    await typeInto("profile-new-password", "new-password-1");
    await typeInto("profile-confirm-password", "new-password-1");
    await submitPasswordForm();

    expect(mockAuthApi.changePassword).toHaveBeenCalledTimes(1);
    const alert = container.querySelector('[role="alert"]');
    expect(alert).not.toBeNull();
    expect(alert?.textContent).not.toContain("Invalid password");
    expect(container.querySelector('[role="status"]')).toBeNull();

    await act(async () => {
      root.unmount();
    });
  });

  it("hides the change-password block for accounts without a password", async () => {
    mockAuthApi.listAccounts.mockResolvedValue([{ providerId: "oidc" }]);
    const root = await renderProfile();
    expect(container.querySelector('[data-testid="change-password-form"]')).toBeNull();

    await act(async () => {
      root.unmount();
    });
  });
});
