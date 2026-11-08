// @vitest-environment jsdom
// OPE-5957 review: dangerous URL schemes in a page body must never reach an href.
import { createRoot } from "react-dom/client";
import { act } from "react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { KnowledgeMarkdown } from "./KnowledgeMarkdown";

vi.mock("@/context/CompanyContext", () => ({
  useCompany: () => ({ selectedCompany: { issuePrefix: "OPE" } }),
}));

beforeAll(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

let container: HTMLDivElement | null = null;
afterEach(() => {
  container?.remove();
  container = null;
});

async function hrefsOf(body: string): Promise<string[]> {
  container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(
      <MemoryRouter>
        <KnowledgeMarkdown body={body} spaceKey="ops" basePath="/wiki" />
      </MemoryRouter>,
    );
  });
  const hrefs = Array.from(container.querySelectorAll("a")).map((a) => a.getAttribute("href") ?? "");
  await act(async () => root.unmount());
  return hrefs;
}

const DANGEROUS = [
  "javascript:alert(1)",
  "JaVaScRiPt:alert(1)",
  " javascript:alert(1)",
  "java\tscript:alert(1)",
  "java\nscript:alert(1)",
  "vbscript:msgbox(1)",
  "data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==",
  "DATA:text/html,<script>alert(1)</script>",
];

describe("KnowledgeMarkdown urls", () => {
  it.each(DANGEROUS)("drops %j from the href", async (url) => {
    const hrefs = await hrefsOf(`[x](<${url}>)\n\n[y](${url.replace(/\s/g, "%20")})`);
    for (const href of hrefs) {
      expect(href.replace(/[\s\u0000-\u001f]/g, "").toLowerCase()).not.toMatch(/^(javascript|vbscript|data):/);
    }
  });

  it("keeps ordinary links", async () => {
    const hrefs = await hrefsOf("[a](https://example.com/x) [b](mailto:a@b.c) [c](../servers/vm-core.md)");
    expect(hrefs).toEqual(["https://example.com/x", "mailto:a@b.c", "/OPE/wiki/servers/vm-core"]);
  });
});
