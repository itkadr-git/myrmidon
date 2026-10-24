// @vitest-environment jsdom

import { PRODUCT_NAME } from "@myrmidon/shared";
import { i18n } from "@/i18n";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BreadcrumbProvider, buildDocumentTitle, useBreadcrumbs } from "./BreadcrumbContext";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

describe("BreadcrumbContext", () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
  });

  it("does not rerender consumers when breadcrumbs are set to the same values", () => {
    const renderCounts: number[] = [];
    let updateBreadcrumbs: ((crumbs: Array<{ label: string; href?: string }>) => void) | null = null;

    function TestConsumer() {
      const { breadcrumbs, setBreadcrumbs } = useBreadcrumbs();
      renderCounts.push(breadcrumbs.length);
      updateBreadcrumbs = setBreadcrumbs;
      return null;
    }

    act(() => {
      root.render(
        <BreadcrumbProvider>
          <TestConsumer />
        </BreadcrumbProvider>,
      );
    });

    expect(renderCounts).toHaveLength(1);

    act(() => {
      updateBreadcrumbs?.([{ label: "Issues", href: "/issues" }, { label: "PAP-1488" }]);
    });

    expect(renderCounts).toHaveLength(2);

    act(() => {
      updateBreadcrumbs?.([{ label: "Issues", href: "/issues" }, { label: "PAP-1488" }]);
    });

    expect(renderCounts).toHaveLength(2);
  });

  it("rerenders consumers when only the crumb identifier changes", () => {
    const renderCounts: number[] = [];
    let updateBreadcrumbs:
      | ((crumbs: Array<{ label: string; href?: string; identifier?: string }>) => void)
      | null = null;

    function TestConsumer() {
      const { breadcrumbs, setBreadcrumbs } = useBreadcrumbs();
      renderCounts.push(breadcrumbs.length);
      updateBreadcrumbs = setBreadcrumbs;
      return null;
    }

    act(() => {
      root.render(
        <BreadcrumbProvider>
          <TestConsumer />
        </BreadcrumbProvider>,
      );
    });

    expect(renderCounts).toHaveLength(1);

    act(() => {
      updateBreadcrumbs?.([{ label: "First task prompt", identifier: "PAP-1204" }]);
    });

    expect(renderCounts).toHaveLength(2);

    // Same everything but a new identifier must produce a fresh render.
    act(() => {
      updateBreadcrumbs?.([{ label: "First task prompt", identifier: "PAP-1205" }]);
    });

    expect(renderCounts).toHaveLength(3);

    // Identical identifier is a no-op.
    act(() => {
      updateBreadcrumbs?.([{ label: "First task prompt", identifier: "PAP-1205" }]);
    });

    expect(renderCounts).toHaveLength(3);
  });

  it("builds page titles with the selected company name before the shared product name", () => {
    expect(buildDocumentTitle([{ label: "Inbox" }], "Anachronist Wiki")).toBe(
      `Inbox • Anachronist Wiki • ${PRODUCT_NAME}`,
    );
    expect(
      buildDocumentTitle(
        [{ label: "Issues", href: "/issues" }, { label: "PAP-3515" }],
        "Anachronist Wiki",
      ),
    ).toBe(`PAP-3515 • Issues • Anachronist Wiki • ${PRODUCT_NAME}`);
  });

  it("omits blank company names and keeps the shared product name on every locale", () => {
    expect(buildDocumentTitle([{ label: "Inbox" }], "  ")).toBe(`Inbox • ${PRODUCT_NAME}`);
    expect(buildDocumentTitle([], null)).toBe(PRODUCT_NAME);
    expect(i18n.getFixedT("en")("about.title")).toContain(PRODUCT_NAME);
    expect(i18n.getFixedT("ru")("about.title")).toContain(PRODUCT_NAME);
  });
});
