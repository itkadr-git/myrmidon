import { expect, test } from "@playwright/test";

const labels = {
  en: ["Knowledge review", "Recommendation: accept", "Recommendation: reject", "No pending suggestions"],
  ru: ["Разбор предложений знаний", "Рекомендация: принять", "Рекомендация: отклонить", "Нет предложений на разбор"],
} as const;

for (const locale of ["en", "ru"] as const) {
  for (const width of [390, 1440]) {
    test(`review queue and empty state in ${locale} at ${width}px`, async ({ page }) => {
      const [heading, accept, reject, empty] = labels[locale];
      const other = labels[locale === "en" ? "ru" : "en"];
      const longText = "x".repeat(500);
      const suggestions = [
        { id: "accept", body: `A ${longText}`, recommendation: "accepted", rationale: `Reason A ${longText}` },
        { id: "reject", body: "B", recommendation: "rejected", rationale: "Reason B" },
        { id: "legacy", body: "C", recommendation: null, rationale: "Legacy reason", trust: "high" },
      ].map((row) => ({ status: "pending", targetItemId: null, ...row }));
      await page.setViewportSize({ width, height: 844 });
      await page.addInitScript((language) => localStorage.setItem("myrmidon:ui-language", language), locale);
      let rows = suggestions;
      await page.route("**/api/myrmidon/companies/company-1/knowledge/suggestions?status=pending", async (route) => {
        expect(route.request().method()).toBe("GET");
        await route.fulfill({ json: { suggestions: rows } });
      });
      await page.goto("/knowledge-qa.html?screen=review");

      const review = page.locator("#main-content");
      const cards = review.locator("article");
      await expect(review.getByRole("heading", { name: heading })).toBeVisible();
      await expect(cards).toHaveCount(3);
      await expect(cards.nth(0).getByText(accept, { exact: true })).toBeVisible();
      await expect(cards.nth(0)).toContainText(`Reason A ${longText}`);
      await expect(cards.nth(1).getByText(reject, { exact: true })).toBeVisible();
      await expect(cards.nth(1)).toContainText("Reason B");
      await expect(cards.nth(2)).toContainText("Legacy reason");
      await expect(review.getByText(accept, { exact: true })).toHaveCount(1);
      await expect(review.getByText(reject, { exact: true })).toHaveCount(1);
      for (const label of other) await expect(review.getByText(label, { exact: true })).toHaveCount(0);
      await expect.poll(() => review.evaluate((element) => [element, ...element.querySelectorAll("article, article p")]
        .every((node) => node.scrollWidth <= node.clientWidth + 1))).toBe(true);

      rows = [];
      await page.reload();
      await expect(review.getByText(empty, { exact: true })).toBeVisible();
      await expect(cards).toHaveCount(0);
      await expect(review.getByText(other[3], { exact: true })).toHaveCount(0);
    });
  }
}
