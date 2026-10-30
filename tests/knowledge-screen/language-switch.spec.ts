import fs from "node:fs";
import path from "node:path";
import { expect, test } from "@playwright/test";

// OPE-9378: 1.6.6 UI2 language switch acceptance smoke.
// Acceptance criteria:
// - Switch EN <-> RU on desktop (1440px) and phone (390px) without page reload.
// - Both storage keys (myrmidon.ui2.locale and myrmidon:ui-language) are updated.
// - Rail / phone header, TopBar, and Settings Sidebar update live.
// - Zero raw keys (e.g. ui2.settings.* or ui2.nav.*) rendered.
// - Screenshots captured to tests/knowledge-screen/screenshots.

const SHOTS = path.join(process.cwd(), "tests/knowledge-screen/screenshots");

test.beforeAll(() => {
  fs.mkdirSync(SHOTS, { recursive: true });
});

test.describe("UI2 Language Switch", () => {
  test("switches between EN and RU without reload on desktop (1440px)", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/knowledge-qa.html?screen=language");
    await page.waitForLoadState("domcontentloaded");

    // Wait for the shell to mount
    const shell = page.locator(".myr-ui2");
    await expect(shell).toBeVisible();

    // Verify initial English state
    const sidebar = page.locator(".myr-ui2-settings-sidebar");
    await expect(sidebar).toBeVisible();
    await expect(sidebar).toContainText("General");
    await expect(sidebar).toContainText("Language");

    // Verify zero raw keys in sidebar and shell
    const sidebarText = await sidebar.innerText();
    expect(sidebarText).not.toMatch(/ui2\.(settings|nav)\./);

    // Click Russian in the top bar or settings language switch
    const ruButton = page.locator(".ui2-language-switch button[lang='ru']").first();
    await expect(ruButton).toBeVisible();
    await ruButton.click();

    // Without reload: verify immediate live update
    await expect(sidebar).toContainText("Общие");
    await expect(sidebar).toContainText("Язык");
    await expect(shell).toHaveAttribute("lang", "ru");

    const ruSidebarText = await sidebar.innerText();
    expect(ruSidebarText).not.toMatch(/ui2\.(settings|nav)\./);

    // Verify both storage keys written
    const storageKeys = await page.evaluate(() => ({
      ui2Locale: window.localStorage.getItem("myrmidon.ui2.locale"),
      appLanguage: window.localStorage.getItem("myrmidon:ui-language"),
    }));
    expect(storageKeys.ui2Locale).toBe("ru");
    expect(storageKeys.appLanguage).toBe("ru");

    await page.screenshot({ path: path.join(SHOTS, "language-switch-1440-ru.png") });

    // Switch back to English without reload
    const enButton = page.locator(".ui2-language-switch button[lang='en']").first();
    await enButton.click();

    await expect(sidebar).toContainText("General");
    await expect(sidebar).toContainText("Language");
    await expect(shell).toHaveAttribute("lang", "en");

    await page.screenshot({ path: path.join(SHOTS, "language-switch-1440-en.png") });
  });

  test("switches between EN and RU without reload on mobile (390px)", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/knowledge-qa.html?screen=language");
    await page.waitForLoadState("domcontentloaded");

    const shell = page.locator(".myr-ui2");
    await expect(shell).toBeVisible();

    // Check phone header and compact LanguageSwitch
    const phoneHeader = page.locator(".myr-ui2__phone-header");
    await expect(phoneHeader).toBeVisible();
    const phoneSwitch = phoneHeader.locator(".ui2-language-switch");
    await expect(phoneSwitch).toBeVisible();

    // Switch to Russian via phone header
    const ruPhoneBtn = phoneSwitch.locator("button[lang='ru']");
    await expect(ruPhoneBtn).toBeVisible();
    await ruPhoneBtn.click();

    // Without reload: verify live update and zero raw keys
    await expect(shell).toHaveAttribute("lang", "ru");
    const shellText = await shell.innerText();
    expect(shellText).not.toMatch(/ui2\.(settings|nav|phone)\./);

    const storageKeys = await page.evaluate(() => ({
      ui2Locale: window.localStorage.getItem("myrmidon.ui2.locale"),
      appLanguage: window.localStorage.getItem("myrmidon:ui-language"),
    }));
    expect(storageKeys.ui2Locale).toBe("ru");
    expect(storageKeys.appLanguage).toBe("ru");

    await page.screenshot({ path: path.join(SHOTS, "language-switch-390-ru.png") });

    // Switch back to English via phone header
    const enPhoneBtn = phoneSwitch.locator("button[lang='en']");
    await enPhoneBtn.click();
    await expect(shell).toHaveAttribute("lang", "en");

    await page.screenshot({ path: path.join(SHOTS, "language-switch-390-en.png") });
  });
});
