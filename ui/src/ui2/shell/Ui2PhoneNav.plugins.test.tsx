// @vitest-environment jsdom
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { Ui2PhoneTabBar } from "./Ui2PhoneNav";
const state = vi.hoisted(() => ({ slots: [] as unknown[], launchers: [] as unknown[] }));
vi.mock("@/i18n", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock("../i18n/Ui2I18n", () => ({ useUi2I18n: () => ({ t: (key: string) => key === "ui2.nav.group.plugins" ? "Плагины" : key }) }));
vi.mock("@/context/CompanyContext", () => ({ useCompany: () => ({ selectedCompany: { id: "c1", issuePrefix: "TES" } }) }));
vi.mock("@/lib/router", () => ({ Link: ({ children, to }: { children: unknown; to: string }) => <a href={to}>{children as never}</a>, useLocation: () => ({ pathname: "/TES/" }) }));
vi.mock("../useUi2Status", () => ({ useUi2AttentionCount: () => null }));
vi.mock("@/plugins/slots", () => ({ usePluginSlots: () => ({ slots: state.slots }), PluginSlotMount: ({ slot }: { slot: { displayName: string } }) => <span>{slot.displayName}</span> }));
vi.mock("@/plugins/launchers", () => ({ usePluginLaunchers: () => ({ launchers: state.launchers }), PluginLauncherOutlet: () => <span>launcher-entry</span> }));
vi.mock("@/components/myrmidon/MyrmidonLockup", () => ({ MyrmidonLockup: () => <span>Brand</span> }));
describe("Ui2PhoneTabBar plugin rendering", () => {
  it("renders sidebar slots and the RU group label", () => { state.slots = [{ displayName: "Выпуск лицензий" }]; state.launchers = []; const html = renderToStaticMarkup(<Ui2PhoneTabBar />); expect(html).toContain("Выпуск лицензий"); expect(html).toContain("Плагины"); });
  it("renders launcher-only entries", () => { state.slots = []; state.launchers = [{ id: "launcher" }]; expect(renderToStaticMarkup(<Ui2PhoneTabBar />)).toContain("launcher-entry"); });
});
