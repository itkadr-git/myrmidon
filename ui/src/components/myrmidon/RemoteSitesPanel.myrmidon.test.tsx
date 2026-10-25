// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ComponentProps } from "react";
import { RemoteSitesPanel, type RemoteBotRow, type RemoteSiteRow } from "./RemoteSitesPanel";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
const now = Date.parse("2026-10-25T12:00:00Z");
const statuses = ["reachable", "degraded", "unreachable", "draining", "quarantined", "disabled", "unknown"] as const;
const labels: Record<(typeof statuses)[number], string> = {
  reachable: "Reachable", degraded: "Degraded", unreachable: "Unreachable", draining: "Draining",
  quarantined: "Quarantined", disabled: "Disabled", unknown: "Not probed yet",
};
const bot = (overrides: Partial<RemoteBotRow> = {}): RemoteBotRow => ({
  botKey: "bot-1", agent: "work-qa", state: "running", image: `img@sha256:${"a".repeat(64)}`, drift: false, driftFields: [],
  apiBaseUrl: "http://10.10.0.110:18701", pinned: false, ...overrides,
});
const site = (status: RemoteSiteRow["status"] = "reachable", overrides: Partial<RemoteSiteRow> = {}): RemoteSiteRow => ({
  name: `site-${status}`, status, registryStatus: status === "draining" ? "draining" : "active", autoDrained: false,
  lastSeenAt: new Date(now - 10_000).toISOString(),
  capacity: { cpus: { used: 2, total: 8 }, memoryMb: { used: 2048, total: 32768 }, bots: { used: 2, total: 13 } },
  botCount: 2, driftCount: 1, clientCertNotAfter: new Date(now + 90 * 86_400_000).toISOString(), bots: [bot()], ...overrides,
});
let container: HTMLDivElement; let root: Root;
beforeEach(() => { container = document.createElement("div"); document.body.appendChild(container); root = createRoot(container); });
afterEach(() => { act(() => root.unmount()); container.remove(); });
function render(props: ComponentProps<typeof RemoteSitesPanel>) { act(() => root.render(<RemoteSitesPanel {...props} />)); }
function click(el: Element | null) { act(() => (el as HTMLElement).click()); }
function button(text: string): HTMLButtonElement {
  const found = Array.from(container.querySelectorAll("button")).find((b) => b.textContent === text);
  if (!found) throw new Error(`no button "${text}"`);
  return found as HTMLButtonElement;
}
const expand = () => click(container.querySelector("button[aria-expanded]"));

describe("RemoteSitesPanel", () => {
  it("renders every status; the fixture disclosure only when asked", () => {
    render({ sites: statuses.map((status) => site(status)), nowMs: now });
    for (const status of statuses) expect(container.querySelector(`[data-testid="remote-site-status-site-${status}"]`)?.textContent).toContain(labels[status]);
    expect(container.textContent).not.toContain("Fixture preview");
    render({ sites: [site()], nowMs: now, fixture: true });
    expect(container.textContent).toContain("Fixture preview");
  });

  it("renders empty, loading and error states", () => {
    render({ sites: [], loading: true }); expect(container.textContent).toContain("Loading sites");
    render({ sites: [] }); expect(container.textContent).toContain("No sites configured");
    render({ sites: [], error: "fixture error" }); expect(container.textContent).toContain("fixture error");
  });

  it("shows capacity used/total, drift, last answer, automatic drain and a stale answer", () => {
    render({ sites: [site("unreachable", { autoDrained: true, lastSeenAt: new Date(now - 120_000).toISOString(), driftCount: null })], nowMs: now });
    expect(container.querySelector('[data-testid="remote-site-capacity-site-unreachable"]')?.textContent).toBe("CPU 2/8 · memory 2048/32768 MB · bots 2/13");
    expect(container.querySelector('[data-testid="remote-site-drift-site-unreachable"]')?.textContent).toBe("Drift: no answer");
    const status = container.querySelector('[data-testid="remote-site-status-site-unreachable"]')?.textContent;
    expect(status).toContain("drained automatically");
    expect(status).toContain("Stale health");
  });

  it("shows the key lifetime: fine, expiring soon, expired as an alert, unknown", () => {
    const cert = (name: string) => container.querySelector(`[data-testid="remote-site-cert-${name}"]`)!;
    render({ sites: [site("reachable", { name: "a" }), site("reachable", { name: "b", clientCertNotAfter: new Date(now + 3 * 86_400_000).toISOString() }),
      site("reachable", { name: "c", clientCertNotAfter: new Date(now - 1).toISOString() }), site("reachable", { name: "d", clientCertNotAfter: null })], nowMs: now });
    expect(cert("a").textContent).toContain("Key valid until");
    expect(cert("b").textContent).toContain("3 d left");
    expect(cert("c").textContent).toContain("Key expired");
    expect(cert("c").getAttribute("role")).toBe("alert");
    expect(cert("a").getAttribute("role")).toBeNull();
    expect(cert("d").textContent).toContain("not known");
  });

  it("expands by keyboard-accessible toggle, asks for the bots, and shows loading and failure of the bot list", () => {
    const onExpand = vi.fn();
    render({ sites: [site("reachable", { bots: undefined })], nowMs: now, onExpand });
    const toggle = container.querySelector("button[aria-expanded]")!;
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(onExpand).toHaveBeenCalledTimes(1);
    expect(container.textContent).toContain("Loading bots");
    render({ sites: [site("reachable", { bots: null })], nowMs: now, onExpand });
    expect(container.textContent).toContain("Could not load the bots");
    render({ sites: [site("reachable", { bots: [] })], nowMs: now, onExpand });
    expect(container.textContent).toContain("No bots");
  });

  it("restarts at once, stops only after the confirmation, and passes the move target", () => {
    const onAction = vi.fn();
    render({ sites: [site()], nowMs: now, onAction, moveTargets: () => ["site-b", "local"] });
    expand();
    click(button("Restart"));
    expect(onAction).toHaveBeenLastCalledWith("restart", expect.objectContaining({ name: "site-reachable" }), expect.objectContaining({ botKey: "bot-1" }));
    click(button("Stop"));
    expect(onAction).toHaveBeenCalledTimes(1);
    click(button("Confirm stop"));
    expect(onAction).toHaveBeenLastCalledWith("stop", expect.anything(), expect.objectContaining({ botKey: "bot-1" }));
    const select = container.querySelector("select") as HTMLSelectElement;
    expect(Array.from(select.options).map((o) => o.value)).toEqual(["", "site-b", "local"]);
    expect(button("Move").disabled).toBe(true);
    act(() => { select.value = "local"; select.dispatchEvent(new Event("change", { bubbles: true })); });
    click(button("Move"));
    expect(onAction).toHaveBeenLastCalledWith("move", expect.anything(), expect.anything(), "local");
  });

  it("shows drift of a bot, its log, and does not move a pinned bot", () => {
    const onAction = vi.fn();
    render({ sites: [site("reachable", { bots: [bot({ drift: true, driftFields: ["HostConfig.Binds"], pinned: true })] })], nowMs: now, onAction, moveTargets: () => ["site-b"], logsByBot: { "bot-1": "line one" } });
    expand();
    expect(container.querySelector('[data-testid="remote-bot-drift-bot-1"]')?.textContent).toBe("Drift: HostConfig.Binds");
    expect(container.querySelector('[data-testid="remote-bot-logs-bot-1"]')?.textContent).toBe("line one");
    expect(button("Hide logs")).toBeTruthy();
    const select = container.querySelector("select") as HTMLSelectElement;
    act(() => { select.value = "site-b"; select.dispatchEvent(new Event("change", { bubbles: true })); });
    expect(button("Move").disabled).toBe(true);
  });

  it("offers Drain on an active site and Resume on a draining one", () => {
    const onAction = vi.fn();
    render({ sites: [site("reachable"), site("draining")], nowMs: now, onAction });
    click(button("Drain"));
    expect(onAction).toHaveBeenLastCalledWith("drain", expect.objectContaining({ name: "site-reachable" }));
    click(button("Resume"));
    expect(onAction).toHaveBeenLastCalledWith("resume", expect.objectContaining({ name: "site-draining" }));
  });

  it("disables bot actions for an expired key, a quarantined or disabled site and while busy; Resume too on an expired key", () => {
    const expired = new Date(now - 1).toISOString();
    for (const overrides of [{ clientCertNotAfter: expired }, { status: "quarantined" as const }, { status: "disabled" as const }]) {
      act(() => root.unmount()); root = createRoot(container);
      render({ sites: [site("reachable", overrides)], nowMs: now, onAction: vi.fn() });
      expand();
      expect(button("Restart").disabled).toBe(true);
      expect(button("Stop").disabled).toBe(true);
    }
    act(() => root.unmount()); root = createRoot(container);
    render({ sites: [site("draining", { clientCertNotAfter: expired })], nowMs: now, onAction: vi.fn() });
    expect(button("Resume").disabled).toBe(true);
    act(() => root.unmount()); root = createRoot(container);
    render({ sites: [site()], nowMs: now, onAction: vi.fn(), busy: true });
    expand();
    expect(button("Restart").disabled).toBe(true);
  });

  it("shows the failure under its site", () => {
    render({ sites: [site(), site("degraded")], nowMs: now, failure: { site: "site-degraded", message: "quarantined" } });
    const alerts = Array.from(container.querySelectorAll('[role="alert"]')).map((a) => a.textContent);
    expect(alerts).toEqual(["The action did not go through: quarantined"]);
  });
});
