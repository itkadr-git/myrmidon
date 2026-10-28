import fs from "node:fs";
import path from "node:path";
import { expect, test, type Page } from "@playwright/test";

// OPE-5957 / OPE-9222. Owner's rejection of the screen on prod:
//   1. nothing scrolled: a long page and the tree were cut off;
//   2. Markdown was shown raw (`# Бэкапы`, `[vm-core](../servers/vm-core.md)`);
//   3. English captions while the interface language is Russian.
// Real rendering, both screens, both window sizes; screenshots go to
// tests/knowledge-screen/screenshots (uploaded as a CI artifact).

const SIZES = [
  { width: 2560, height: 1440 },
  { width: 1920, height: 1080 },
  { width: 1366, height: 768 },
  { width: 390, height: 844 },
] as const;
const SCREENS = [
  { id: "ui2", main: '[data-testid="ui2-main"]' },
  { id: "legacy", main: "#main-content" },
] as const;

// Run from the repository root (see the workflow and `pnpm test:knowledge-screen`).
const SHOTS = path.join(process.cwd(), "tests/knowledge-screen/screenshots");
const LAST_LINE = "LAST-LINE-MARKER";
const TREE_COUNT = 90;

const treeItems = Array.from({ length: TREE_COUNT }, (_, index) => ({
  id: `i-${index}`,
  slug: `item-${String(index).padStart(2, "0")}`,
  folderPath: "infra",
  title: `Страница ${String(index).padStart(2, "0")}`,
  status: "published",
  currentRevisionNumber: 1,
  updatedAt: "2026-10-20T10:00:00.000Z",
  parentSlug: null,
  reviewDueAt: null,
}));
const longPage = {
  id: "i-long",
  slug: "long-page",
  folderPath: "infra",
  title: "Бэкапы",
  status: "published",
  currentRevisionNumber: 1,
  updatedAt: "2026-10-20T10:00:00.000Z",
  parentSlug: null,
  reviewDueAt: null,
};
const sections = Array.from(
  { length: 70 },
  (_, index) => `## Раздел ${index + 1}\n\nТекст раздела ${index + 1}, **важное** и \`код\`.\n\n- пункт один\n- пункт два\n`,
).join("\n");
const body = `# Бэкапы\n\nСмотри [vm-core](../servers/vm-core.md) и [[infra/item-01]].\n\n${sections}\n${LAST_LINE}\n`;

async function mockApi(page: Page) {
  await page.route((url) => url.pathname.startsWith("/api/"), async (route) => {
    const url = new URL(route.request().url());
    const pathname = decodeURIComponent(url.pathname);
    const json = (data: unknown) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(data) });
    if (pathname.endsWith("/dashboard")) {
      return json({
        agents: { running: 1, active: 2, paused: 0, error: 0 },
        costs: { monthSpendCents: 0, monthBudgetCents: 0 },
      });
    }
    if (pathname.endsWith("/sidebar-badges")) return json({ inbox: 0, approvals: 0, failedRuns: 0 });
    if (!pathname.includes("/knowledge/")) return json([]);
    if (pathname.endsWith("/knowledge/items")) return json({ items: [longPage, ...treeItems] });
    if (pathname.endsWith("/revisions")) {
      return json({
        revisions: [
          {
            id: "r-1",
            itemId: "i-long",
            revisionNumber: 1,
            status: "approved",
            content: body,
            createdAt: "2026-10-20T10:00:00.000Z",
            sources: [],
          },
        ],
      });
    }
    if (pathname.endsWith("/backlinks")) return json({ backlinks: [] });
    if (pathname.includes("/knowledge/items/")) return json({ item: longPage });
    return json({});
  });
}

for (const screen of SCREENS) {
  for (const size of SIZES) {
    test(`${screen.id} ${size.width}x${size.height}: scroll, markdown, Russian captions`, async ({ page }) => {
      fs.mkdirSync(SHOTS, { recursive: true });
      await page.setViewportSize(size);
      await page.addInitScript(() => {
        window.localStorage.setItem("myrmidon:ui-language", "ru");
        window.localStorage.removeItem("myrmidon.ui2.locale");
      });
      page.on("pageerror", (error) => console.log(`[pageerror] ${error.message}`));
      page.on("console", (message) => {
        if (message.type() === "error") console.log(`[console.error] ${message.text().slice(0, 400)}`);
      });
      await mockApi(page);
      await page.goto(`/knowledge-qa.html?screen=${screen.id}&page=infra/long-page`);

      const bodyBox = page.locator(".ui2-knowledge-body");
      await expect(bodyBox).toBeVisible();

      // 3. Russian captions.
      const text = await page.locator("body").innerText();
      for (const caption of ["Знания", "По тексту", "По смыслу", "Ревизия 1", "Обновлено"]) {
        expect(text, `caption "${caption}"`).toContain(caption);
      }
      // On phones the tree is intentionally collapsed behind its menu trigger.
      if (size.width <= 390) {
        const treeToggle = page.getByRole("button", { name: /дерево|tree/i });
        await expect(treeToggle).toBeVisible();
        await treeToggle.click();
        await expect(page.getByText("Дерево знаний")).toBeVisible();
      } else {
        expect(text).toContain("Дерево знаний");
      }
      for (const english of ["Knowledge tree", "Full text", "Semantic", "Search knowledge", "Updated "]) {
        expect(text, `English caption "${english}" must not appear`).not.toContain(english);
      }
      await expect(page.locator("input.ui2-knowledge-search-input")).toHaveAttribute("placeholder", "Поиск по знаниям…");

      // 2. Markdown is rendered: a heading and a working link, no raw markup.
      await expect(bodyBox.locator("h1")).toHaveText("Бэкапы");
      await expect(bodyBox.locator("h2").first()).toHaveText("Раздел 1");
      const relativeLink = bodyBox.getByRole("link", { name: "vm-core" });
      await expect(relativeLink).toBeVisible();
      expect(await relativeLink.getAttribute("href")).toMatch(/vm-core$/);
      const bodyText = await bodyBox.innerText();
      expect(bodyText).not.toContain("# Бэкапы");
      expect(bodyText).not.toContain("](../servers/vm-core.md)");
      expect(bodyText).not.toContain("[[");
      await expect(bodyBox.locator("ul li").first()).toBeVisible();

      const horizontal = await page.evaluate(() => ({
        scrollWidth: document.documentElement.scrollWidth,
        clientWidth: document.documentElement.clientWidth,
      }));
      expect(horizontal.scrollWidth, "viewport has no horizontal overflow").toBeLessThanOrEqual(horizontal.clientWidth);

      // 1a. The long page scrolls down to its last line.
      const main = page.locator(screen.main);
      const metrics = await main.evaluate((el) => ({ scroll: el.scrollHeight, client: el.clientHeight }));
      expect(metrics.scroll, "page is taller than the window").toBeGreaterThan(metrics.client + 200);
      await page.screenshot({ path: path.join(SHOTS, `${screen.id}-${size.width}x${size.height}-top.png`) });
      await main.evaluate((el) => {
        el.scrollTop = el.scrollHeight;
      });
      const last = bodyBox.getByText(LAST_LINE);
      await expect(last).toBeInViewport();
      await page.screenshot({ path: path.join(SHOTS, `${screen.id}-${size.width}x${size.height}-bottom.png`) });

      // 1b. The tree scrolls on its own down to the last item.
      await main.evaluate((el) => {
        el.scrollTop = 0;
      });
      const tree = page.locator('[data-testid="knowledge-tree-scroll"]');
      const treeMetrics = await tree.evaluate((el) => ({
        scroll: el.scrollHeight,
        client: el.clientHeight,
        overflowY: getComputedStyle(el).overflowY,
      }));
      expect(treeMetrics.overflowY).toBe("auto");
      expect(treeMetrics.scroll, "tree is taller than its pane").toBeGreaterThan(treeMetrics.client + 100);
      await tree.evaluate((el) => {
        el.scrollTop = el.scrollHeight;
      });
      await expect(tree.getByRole("button", { name: `Страница ${TREE_COUNT - 1}` })).toBeInViewport();
      await page.screenshot({ path: path.join(SHOTS, `${screen.id}-${size.width}x${size.height}-tree.png`) });
    });
  }
}
