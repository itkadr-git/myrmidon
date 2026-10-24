// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { accessApi } from "@/api/access";
import { AdminUsers } from "./AdminUsers";

vi.mock("@/api/access", () => ({ accessApi: { searchAdminUsers: vi.fn() } }));
vi.mock("@/context/BreadcrumbContext", () => ({ useBreadcrumbs: () => ({ setBreadcrumbs: vi.fn() }) }));

let container: HTMLDivElement;
let root: Root;
let client: QueryClient;

async function renderPage() {
  await act(async () => root.render(<QueryClientProvider client={client}><AdminUsers /></QueryClientProvider>));
}

beforeEach(() => {
  vi.clearAllMocks();
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  client.clear();
  container.remove();
});

describe("AdminUsers", () => {
  it("loads and displays the user list", async () => {
    vi.mocked(accessApi.searchAdminUsers).mockResolvedValue([{
      id: "u1", name: "Avery Admin", email: "avery@example.com", image: null,
      isInstanceAdmin: true, activeCompanyMembershipCount: 2,
    }]);
    await renderPage();
    expect(container.textContent).toContain("Loading users");
    await vi.waitFor(() => expect(container.textContent).toContain("avery@example.com"));
    expect(container.textContent).toContain("Instance admin");
    expect(container.textContent).toContain("2");
    expect(accessApi.searchAdminUsers).toHaveBeenCalledWith("");
  });

  it("shows an error and retry action when loading fails", async () => {
    vi.mocked(accessApi.searchAdminUsers).mockRejectedValue(new Error("network"));
    await renderPage();
    await vi.waitFor(() => expect(container.textContent).toContain("Failed to load users."));
    expect(container.querySelector("[role=alert]")).not.toBeNull();
    expect(container.textContent).toContain("Try again");
  });

  it("shows an empty state when no users are returned", async () => {
    vi.mocked(accessApi.searchAdminUsers).mockResolvedValue([]);
    await renderPage();
    await vi.waitFor(() => expect(container.textContent).toContain("No users found."));
  });
});
