// @vitest-environment jsdom

import { createElement, act } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { i18n } from "@/i18n";
import {
  PluginSlotMount,
  PluginBridgeScope,
  _collectRegisterableExportNamesForTests,
  _resetPluginModuleLoader,
  _rewriteBareSpecifiersForTests,
  registerPluginWebComponent,
  slotContextToHostContext,
  type ResolvedPluginSlot,
} from "./slots";
import { useHostContext, type PluginHostContext } from "./bridge";
import { buildLauncherHostContext } from "./launchers";

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

describe("slotContextToHostContext", () => {
  it("populates locale and language fields matching board i18n language", async () => {
    const prevLang = i18n.language;
    try {
      await i18n.changeLanguage("ru");
      const hostContextRu = slotContextToHostContext(
        { companyId: "comp-1", companyPrefix: "PAP" },
        "user-1",
        false,
      );
      expect(hostContextRu.locale).toBe("ru");
      expect(hostContextRu.language).toBe("ru");

      await i18n.changeLanguage("en");
      const hostContextEn = slotContextToHostContext(
        { companyId: "comp-1", companyPrefix: "PAP" },
        "user-1",
        false,
      );
      expect(hostContextEn.locale).toBe("en");
      expect(hostContextEn.language).toBe("en");
    } finally {
      await i18n.changeLanguage(prevLang);
    }
  });
});


describe("buildLauncherHostContext", () => {
  it("populates locale and language fields matching board i18n language", async () => {
    const prevLang = i18n.language;
    try {
      await i18n.changeLanguage("ru");
      const ctxRu = buildLauncherHostContext(
        { companyId: "comp-1", companyPrefix: "PAP" },
        null,
        "user-1",
      );
      expect(ctxRu.locale).toBe("ru");
      expect(ctxRu.language).toBe("ru");

      await i18n.changeLanguage("en");
      const ctxEn = buildLauncherHostContext(
        { companyId: "comp-1", companyPrefix: "PAP" },
        null,
        "user-1",
      );
      expect(ctxEn.locale).toBe("en");
      expect(ctxEn.language).toBe("en");
    } finally {
      await i18n.changeLanguage(prevLang);
    }
  });
});

describe("PluginBridgeScope mounted hostContext reactivity", () => {
  it("reactively updates consumer hostContext when i18n language changes", async () => {
    const prevLang = i18n.language;
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: 0 } },
    });
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    roots.push(root);

    let observedContext: PluginHostContext | null = null;
    function Consumer() {
      observedContext = useHostContext();
      return createElement("div", { "data-testid": "consumer-locale" }, observedContext.locale);
    }

    try {
      await i18n.changeLanguage("ru");
      await act(async () => {
        root.render(
          createElement(
            QueryClientProvider,
            { client: queryClient },
            createElement(
              PluginBridgeScope,
              {
                pluginId: "test-plugin",
                context: { companyId: "comp-1", companyPrefix: "PAP" },
              },
              createElement(Consumer),
            ),
          ),
        );
      });

      expect(observedContext).not.toBeNull();
      expect(observedContext!.locale).toBe("ru");
      expect(observedContext!.language).toBe("ru");
      expect(container.querySelector("[data-testid=consumer-locale]")?.textContent).toBe("ru");

      await act(async () => {
        await i18n.changeLanguage("en");
      });

      expect(observedContext!.locale).toBe("en");
      expect(observedContext!.language).toBe("en");
      expect(container.querySelector("[data-testid=consumer-locale]")?.textContent).toBe("en");
    } finally {
      await i18n.changeLanguage(prevLang);
    }
  });
});
