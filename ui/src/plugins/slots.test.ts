// @vitest-environment jsdom

import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import {
  PluginSlotMount,
  _collectRegisterableExportNamesForTests,
  _resetPluginModuleLoader,
  _rewriteBareSpecifiersForTests,
  registerPluginWebComponent,
  type ResolvedPluginSlot,
} from "./slots";

let roots: Root[] = [];

afterEach(() => {
  for (const root of roots) {
    flushSync(() => {
      root.unmount();
    });
  }
  roots = [];
  _resetPluginModuleLoader();
});

describe("plugin slot export registration", () => {
  it("keeps declared missing exports visible for diagnostics", () => {
    const exports = _collectRegisterableExportNamesForTests(
      { Page: () => null },
      new Set(["Page", "MissingRouteSidebar"]),
    );

    expect([...exports]).toEqual(["Page", "MissingRouteSidebar"]);
  });

  it("registers component-like module exports even when the current contribution did not declare them", () => {
    const exports = _collectRegisterableExportNamesForTests(
      {
        Page: () => null,
        RouteSidebar: () => null,
        webComponentTag: "paperclip-widget",
        metadata: { ignored: true },
        count: 1,
        default: () => null,
      },
      new Set(["Page"]),
    );

    expect(exports).toEqual(new Set(["Page", "RouteSidebar", "webComponentTag"]));
  });

  it("updates an already-mounted placeholder when the slot export registers later", async () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    roots.push(root);
    const slot: ResolvedPluginSlot = {
      type: "routeSidebar",
      id: "content-machine-sidebar",
      displayName: "Content",
      exportName: "ContentMachineRouteSidebar",
      routePath: "content-machine",
      pluginId: "content-machine-plugin",
      pluginKey: "content-machine",
      pluginDisplayName: "Content Machine",
      pluginVersion: "1.0.0",
    };

    flushSync(() => {
      root.render(createElement(PluginSlotMount, {
        slot,
        context: { companyId: "company-1", companyPrefix: "PAP" },
        missingBehavior: "placeholder",
      }));
    });

    expect(container.textContent).toContain("Content Machine: Content");

    flushSync(() => {
      registerPluginWebComponent("content-machine", "ContentMachineRouteSidebar", "paperclip-test-sidebar");
    });

    expect(container.textContent).not.toContain("Content Machine: Content");
    expect(container.querySelector("paperclip-test-sidebar")).not.toBeNull();
  });
});

describe("plugin bundle bare specifier rewriting", () => {
  it("rewrites legacy @paperclipai SDK specifiers to the same shim as @myrmidon", () => {
    let counter = 0;
    const original = URL.createObjectURL;
    URL.createObjectURL = () => `blob:shim-${++counter}`;
    try {
      const bundle = (scope: string) =>
        [
          `import { usePluginData } from "${scope}/plugin-sdk/ui";`,
          `import { useHostContext } from '${scope}/plugin-sdk/ui/hooks';`,
          `import * as Q from '${scope}/plugin-sdk/ui';`,
        ].join("\n");
      const mine = _rewriteBareSpecifiersForTests(bundle("@myrmidon"));
      const legacy = _rewriteBareSpecifiersForTests(bundle("@paperclipai"));
      expect(legacy).toBe(mine);
      expect(legacy).not.toContain("plugin-sdk");
      expect(legacy.match(/blob:shim-\d+/g)?.length).toBe(3);
      expect(new Set(legacy.match(/blob:shim-\d+/g)).size).toBe(1);
    } finally {
      URL.createObjectURL = original;
    }
  });
});
