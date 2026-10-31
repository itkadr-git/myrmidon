// @vitest-environment jsdom
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { Ui2Rail } from "./Ui2Rail";
import { Ui2PhoneTabBar } from "./Ui2PhoneNav";

let mockLocation = { pathname: "/TES/fleet" };

vi.mock("@/i18n", () => ({
  useTranslation: () => ({ t: (k: string) => k }),
}));
vi.mock("../i18n/Ui2I18n", () => ({
  useUi2I18n: () => ({ t: (k: string) => k }),
}));
vi.mock("@/context/CompanyContext", () => ({
  useCompany: () => ({ selectedCompany: { id: "c1", issuePrefix: "TES" } }),
}));
vi.mock("@/lib/router", () => ({
  Link: ({ children, to, ...props }: { children: unknown; to: string; [key: string]: unknown }) => (
    <a href={to} {...(props as Record<string, unknown>)}>
      {children as never}
    </a>
  ),
  useLocation: () => mockLocation,
}));
vi.mock("../useUi2Status", () => ({ useUi2AttentionCount: () => 0 }));
vi.mock("../useKnowledgeAvailable", () => ({ useKnowledgeAvailable: () => true }));
vi.mock("@/components/myrmidon/MyrmidonLockup", () => ({
  MyrmidonLockup: () => <span data-testid="lockup" />,
}));
vi.mock("@/plugins/slots", () => ({
  usePluginSlots: () => ({ slots: [] }),
  PluginSlotMount: () => null,
}));
vi.mock("@/plugins/launchers", () => ({
  usePluginLaunchers: () => ({ launchers: [] }),
  PluginLauncherOutlet: () => null,
}));

function getAriaCurrentLinks(html: string): Element[] {
  const doc = new DOMParser().parseFromString(html, "text/html");
  return Array.from(doc.querySelectorAll('[aria-current="page"]'));
}

describe("Ui2 navigation aria-current single active item (OPE-9637)", () => {
  it("marks exactly one rail item with aria-current='page' at /{P}/fleet", () => {
    mockLocation = { pathname: "/TES/fleet" };
    const html = renderToStaticMarkup(<Ui2Rail />);
    const currentLinks = getAriaCurrentLinks(html);
    expect(currentLinks).toHaveLength(1);
    expect(currentLinks[0]?.getAttribute("href")).toBe("/fleet");
  });

  it("marks exactly one rail item with aria-current='page' at /fleet", () => {
    mockLocation = { pathname: "/fleet" };
    const html = renderToStaticMarkup(<Ui2Rail />);
    const currentLinks = getAriaCurrentLinks(html);
    expect(currentLinks).toHaveLength(1);
    expect(currentLinks[0]?.getAttribute("href")).toBe("/fleet");
  });

  it("marks exactly one phone tab with aria-current='page' at /{P}/fleet", () => {
    mockLocation = { pathname: "/TES/fleet" };
    const html = renderToStaticMarkup(<Ui2PhoneTabBar />);
    const currentLinks = getAriaCurrentLinks(html);
    expect(currentLinks).toHaveLength(1);
    expect(currentLinks[0]?.getAttribute("href")).toBe("/fleet");
  });

  it("marks exactly one phone tab with aria-current='page' at /fleet", () => {
    mockLocation = { pathname: "/fleet" };
    const html = renderToStaticMarkup(<Ui2PhoneTabBar />);
    const currentLinks = getAriaCurrentLinks(html);
    expect(currentLinks).toHaveLength(1);
    expect(currentLinks[0]?.getAttribute("href")).toBe("/fleet");
  });
});
