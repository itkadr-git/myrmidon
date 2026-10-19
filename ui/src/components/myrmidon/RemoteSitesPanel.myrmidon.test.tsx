// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ComponentProps } from "react";
import { RemoteSitesPanel, type RemoteSiteRow } from "./RemoteSitesPanel";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
const now = Date.parse("2026-10-17T12:00:00Z");
const statuses = ["reachable", "degraded", "unreachable", "draining", "quarantined", "disabled"] as const;
const site = (status: RemoteSiteRow["status"] = "reachable"): RemoteSiteRow => ({
  name: `fixture-site-${status}`, status, lastSeenAt: new Date(now - 10_000).toISOString(), capacity: { used: 2, total: 8 }, botCount: 1, driftCount: 0,
  clientCertNotAfter: new Date(now + 86_400_000).toISOString(),
  bots: [{ agent: "fixture-agent", imageDigest: `sha256:${"a".repeat(64)}`, state: "running", drift: false, apiBaseUrl: "https://fixture.invalid" }],
});
let container: HTMLDivElement; let root: Root;
beforeEach(() => { container = document.createElement("div"); document.body.appendChild(container); root = createRoot(container); });
afterEach(() => { act(() => root.unmount()); container.remove(); });
function render(props: ComponentProps<typeof RemoteSitesPanel>) { act(() => root.render(<RemoteSitesPanel {...props} />)); }
function click(el: Element | null) { act(() => (el as HTMLElement).click()); }
describe("RemoteSitesPanel", () => {
  it("renders all states with test-fixture disclosure", () => {
    render({ sites: statuses.map(status => site(status)), nowMs: now });
    for (const status of statuses) expect(container.textContent).toContain(status[0].toUpperCase() + status.slice(1));
    expect(container.textContent).toContain("Fixture preview");
  });
  it("renders empty, loading and error states", () => {
    render({ sites: [], loading: true }); expect(container.textContent).toContain("Loading sites");
    render({ sites: [] }); expect(container.textContent).toContain("No sites configured");
    render({ sites: [], error: "fixture error" }); expect(container.textContent).toContain("fixture error");
  });
  it("shows details on keyboard-accessible expansion and enables only permitted actions", () => {
    const onAction = vi.fn(); render({ sites: [site()], nowMs: now, onAction, allowedActions: { restart: true } });
    const toggle = container.querySelector("button")!; expect(toggle.getAttribute("aria-expanded")).toBe("false"); click(toggle);
    expect(container.textContent).toContain("fixture-agent");
    const buttons = Array.from(container.querySelectorAll("button"));
    expect(buttons[1].disabled).toBe(false); expect(buttons[2].disabled).toBe(true);
    click(buttons[1]); expect(onAction).toHaveBeenCalledTimes(1);
  });
  it("disables operations for stale health and expired certificates", () => {
    for (const overrides of [{ lastSeenAt: new Date(now - 120_000).toISOString() }, { clientCertNotAfter: new Date(now - 1).toISOString() }]) {
      act(() => root.unmount());
      root = createRoot(container);
      render({ sites: [{ ...site(), ...overrides }], nowMs: now, onAction: vi.fn(), allowedActions: { restart: true } });
      click(container.querySelector("button"));
      expect(container.querySelectorAll("button")[1]?.disabled).toBe(true);
    }
    expect(container.textContent).toContain("Client certificate expired");
  });
});
