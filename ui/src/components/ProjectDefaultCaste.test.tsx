// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { Project } from "@myrmidonai/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ProjectDefaultCaste } from "./ProjectDefaultCaste";
import { castesApi, type CasteView } from "./myrmidon/castes/castesApi";
import { projectsApi } from "@/api/projects";

vi.mock("./myrmidon/castes/castesApi", () => ({ castesApi: { view: vi.fn() }, castesQueryKey: (id: string) => ["castes", id] }));
vi.mock("@/api/projects", () => ({ projectsApi: { update: vi.fn() } }));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const project = { id: "project-1", companyId: "company-1", defaultCasteKey: "engineer" } as unknown as Project;
const castes = [{ key: "engineer", nameEn: "Engineer" }, { key: "infra", nameEn: "Infrastructure" }] as CasteView[];
let root: Root;
let container: HTMLDivElement;
let client: QueryClient;
async function render(editable = true) {
  container = document.createElement("div");
  document.body.appendChild(container);
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  root = createRoot(container);
  await act(async () => { root.render(<QueryClientProvider client={client}><ProjectDefaultCaste project={project} editable={editable} /></QueryClientProvider>); });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
}
async function choose(value: string) {
  await act(async () => {
    const select = container.querySelector("select")!;
    select.value = value;
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
}
afterEach(() => { if (root) act(() => root.unmount()); container?.remove(); client?.clear(); vi.resetAllMocks(); });
describe("ProjectDefaultCaste", () => {
  it("loads the company directory and current value with an accessible label", async () => {
    vi.mocked(castesApi.view).mockResolvedValue({ castes });
    await render();
    expect(castesApi.view).toHaveBeenCalledWith("company-1");
    const select = container.querySelector("select")!;
    expect(select.value).toBe("engineer");
    expect(container.querySelector("label")?.htmlFor).toBe(select.id);
    expect(Array.from(select.options).map((option) => option.value)).toEqual(["", "engineer", "infra"]);
  });
  it("saves the exact PATCH contract and supports clearing", async () => {
    vi.mocked(castesApi.view).mockResolvedValue({ castes });
    vi.mocked(projectsApi.update).mockResolvedValue(project);
    await render();
    await choose("infra");
    expect(projectsApi.update).toHaveBeenLastCalledWith("project-1", { defaultCasteKey: "infra" }, "company-1");
    expect(container.textContent).toContain("Default caste saved.");
    await choose("");
    expect(projectsApi.update).toHaveBeenLastCalledWith("project-1", { defaultCasteKey: null }, "company-1");
  });
  it("retains the persisted value on failure and allows retry", async () => {
    vi.mocked(castesApi.view).mockResolvedValue({ castes });
    vi.mocked(projectsApi.update).mockRejectedValueOnce(new Error("422")).mockResolvedValue(project);
    await render();
    await choose("infra");
    expect(container.querySelector("select")?.value).toBe("engineer");
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("Could not save");
    await choose("infra");
    expect(container.textContent).toContain("Default caste saved.");
  });
  it("disables editing while loading and on directory failure without invented options", async () => {
    let reject!: (error: Error) => void;
    vi.mocked(castesApi.view).mockReturnValue(new Promise((_, fail) => { reject = fail; }));
    await render();
    expect(container.querySelector("select")?.disabled).toBe(true);
    expect(container.textContent).toContain("Loading castes");
    await act(async () => { reject(new Error("network")); await new Promise((resolve) => setTimeout(resolve, 20)); });
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("Could not load");
    expect(container.querySelector("select")?.disabled).toBe(true);
    vi.mocked(castesApi.view).mockResolvedValue({ castes });
    await act(async () => { container.querySelector("button")!.click(); await new Promise((resolve) => setTimeout(resolve, 20)); });
    expect(container.querySelector("select")?.disabled).toBe(false);
  });
  it("blocks duplicate writes during saving", async () => {
    vi.mocked(castesApi.view).mockResolvedValue({ castes });
    let finish!: (value: Project) => void;
    vi.mocked(projectsApi.update).mockReturnValue(new Promise((resolve) => { finish = resolve; }));
    await render();
    await choose("infra");
    expect(container.querySelector("select")?.disabled).toBe(true);
    expect(container.textContent).toContain("Saving...");
    await choose("");
    expect(projectsApi.update).toHaveBeenCalledTimes(1);
    await act(async () => { finish(project); });
    expect(container.querySelector("select")?.disabled).toBe(false);
  });
  it("keeps read-only projects disabled", async () => {
    vi.mocked(castesApi.view).mockResolvedValue({ castes });
    await render(false);
    expect(container.querySelector("select")?.disabled).toBe(true);
    expect(projectsApi.update).not.toHaveBeenCalled();
  });
});
