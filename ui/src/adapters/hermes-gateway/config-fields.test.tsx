// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import { HermesGatewayConfigFields } from "./config-fields";
import type { AdapterConfigFieldsProps } from "../types";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

function renderFields(overrides: Partial<AdapterConfigFieldsProps> = {}) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const mark = vi.fn();
  const set = vi.fn();
  const props: AdapterConfigFieldsProps = {
    mode: "edit",
    isCreate: false,
    adapterType: "hermes_gateway",
    values: null,
    set: null,
    config: {},
    eff: (_group, _field, original) => original,
    mark,
    models: [],
    ...overrides,
  };

  act(() => {
    root.render(
      <TooltipProvider>
        <HermesGatewayConfigFields {...props} />
      </TooltipProvider>,
    );
  });

  return { container, root, mark, set };
}

describe("HermesGatewayConfigFields", () => {
  const roots: Root[] = [];

  afterEach(() => {
    for (const root of roots.splice(0)) {
      act(() => root.unmount());
    }
    document.body.innerHTML = "";
  });

  it("shows the agent-scoped Hindsight bank only in advanced settings", () => {
    const result = renderFields({ config: { hindsight: { bankId: "old-bank", custom: "keep" } }, section: "advanced" });
    roots.push(result.root);
    expect(result.container.querySelector<HTMLInputElement>('input[value="old-bank"]')).toBeTruthy();
    expect(result.container.textContent).not.toContain("raw-token");
    expect(result.container.textContent).toContain("Hindsight bank ID");
    for (const label of ["Hindsight retain tags", "Hindsight bank mission", "Hindsight recall budget", "Hindsight memory mode", "Hindsight auto-retain", "Hindsight observation scopes"]) {
      expect(result.container.textContent).toContain(label);
    }
    const adapter = renderFields({ section: "adapter" });
    roots.push(adapter.root);
    expect(adapter.container.textContent).not.toContain("Hindsight bank ID");
  });

  it("shows the gateway URL and runtime fields in edit mode", () => {
    const result = renderFields({
      config: {
        apiBaseUrl: "http://127.0.0.1:8642",
        apiKey: { type: "secret_ref", secretId: "11111111-1111-4111-8111-111111111111", version: "latest" },
        paperclipApiUrl: "http://127.0.0.1:3100",
        sessionKeyStrategy: "issue",
      },
    });
    roots.push(result.root);

    const text = result.container.textContent ?? "";
    expect(text).toContain("API base URL");
    expect(text).toContain("API key");
    expect(text).toContain("Myrmidon API URL");
    expect(text).toContain("Session key strategy");
    expect(text).toContain("Timeout seconds");
    expect(text).toContain("Event reconnect ms");
    expect(text).toContain("Run create timeout");
    expect(text).toContain("Runtime MCP URL rewrite");
    expect(text).toContain("Runtime MCP internal URL base");
    expect(text).toContain("Central session history");
    expect(text).toContain("Keep active runs alive");
    expect(text).toContain("Log raw redacted gateway events");
    expect(text).toContain("Dangerously allow remote HTTP");
    expect(text).toContain("Poll interval");
    expect(text).toContain("Extra headers");
    expect(text).toContain("Instructions");

    const urlInput = result.container.querySelector<HTMLInputElement>('input[value="http://127.0.0.1:8642"]');
    expect(urlInput).toBeTruthy();

    const apiKeyInput = Array.from(result.container.querySelectorAll<HTMLInputElement>('input[type="password"]'))
      .find((input) => input.placeholder.includes("Stored secret"));
    expect(apiKeyInput).toBeTruthy();

    expect(result.container.querySelector('button[aria-label="Show API key"]')).toBeTruthy();
  });

  it("shows configured central history without offering a plain-text credential field", () => {
    const result = renderFields({ config: { centralHistory: "1", centralHistoryUrl: "https://hindsight.example", centralHistoryBankId: "bank-a" } });
    roots.push(result.root);
    expect(result.container.textContent).toContain("Hindsight URL");
    expect(result.container.textContent).toContain("Hindsight bank ID");
    expect(result.container.textContent).not.toContain("Central history API key");
    expect(result.container.querySelector('input[value="https://hindsight.example"]')).toBeTruthy();
  });
});
