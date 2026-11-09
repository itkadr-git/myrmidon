import { test, expect, request as pwRequest, type APIRequestContext } from "@playwright/test";

/**
 * E2E: Scoped maintenance banner vs board-wide maintenance banner (OPE-9742).
 *
 * Verifies that when a maintenance window is scoped to a single agent (e.g. bot container update),
 * the board does NOT display the full board-wide red maintenance banner, but instead renders
 * a discrete scoped status row containing the affected agent's name and a link to the agent.
 */

const PORT = Number(process.env.PAPERCLIP_E2E_PORT ?? 3199);
const BASE_URL = `http://127.0.0.1:${PORT}`;

async function createCompanyAndAgent(board: APIRequestContext) {
  const companyRes = await board.post(`${BASE_URL}/api/companies`, {
    data: { name: `E2E-MaintenanceScope-${Date.now()}` },
  });
  expect(companyRes.ok()).toBe(true);
  const company = await companyRes.json();

  const agentRes = await board.post(`${BASE_URL}/api/companies/${company.id}/agents`, {
    data: {
      name: "adm-dev-eng-17",
      role: "engineer",
      adapterType: "process",
      adapterConfig: { command: "/usr/bin/true" },
      runtimeConfig: { heartbeat: { enabled: false, wakeOnDemand: false } },
    },
  });
  expect(agentRes.ok()).toBe(true);
  const agent = await agentRes.json();

  return {
    companyId: company.id as string,
    prefix: (company.issuePrefix ?? company.prefix ?? "E2E") as string,
    agentId: agent.id as string,
    agentName: agent.name as string,
  };
}

test.describe("Maintenance Banner Scope (OPE-9742)", () => {
  let board: APIRequestContext;
  let companyId: string;
  let prefix: string;
  let agentId: string;
  let agentName: string;

  test.beforeAll(async () => {
    board = await pwRequest.newContext({ baseURL: BASE_URL });
    const fixture = await createCompanyAndAgent(board);
    companyId = fixture.companyId;
    prefix = fixture.prefix;
    agentId = fixture.agentId;
    agentName = fixture.agentName;
  });

  test.afterEach(async () => {
    // Ensure any open maintenance windows are closed after test
    try {
      await board.post(`${BASE_URL}/api/myrmidon/maintenance`, {
        data: { action: "exit", scope: { type: "agent", id: agentId } },
      });
    } catch {
      // ignore
    }
    try {
      await board.post(`${BASE_URL}/api/myrmidon/maintenance`, {
        data: { action: "exit", scope: { type: "instance" } },
      });
    } catch {
      // ignore
    }
  });

  test("agent-scoped maintenance window shows discrete row with agent name and no board-wide red banner", async ({
    page,
  }) => {
    // 1. Enter maintenance for a single agent (simulating bot container profile update)
    const enterRes = await board.post(`${BASE_URL}/api/myrmidon/maintenance`, {
      data: {
        action: "enter",
        scope: { type: "agent", id: agentId },
        reason: `bot container profile update (${agentName})`,
      },
    });
    expect(enterRes.ok()).toBe(true);

    // 2. Open the board
    await page.goto(`/${prefix}/issues`);

    // 3. Acceptance criterion: common red banner is NOT present
    const boardWideBanner = page.getByTestId("myrmidon-maintenance-banner");
    await expect(boardWideBanner).toHaveCount(0);
    const details = page.getByTestId("myrmidon-maintenance-details");
    await expect(details).toHaveCount(0);

    // 4. Acceptance criterion: discrete row with the agent name is present
    const scopedBanner = page.getByTestId("myrmidon-maintenance-scoped-banner");
    await expect(scopedBanner).toBeVisible();
    await expect(scopedBanner).toContainText(agentName);

    // 5. Link to the agent is present
    const link = scopedBanner.getByRole("link");
    await expect(link).toBeVisible();
    await expect(link).toContainText(agentName);
  });

  test("mocked agent maintenance window displays discrete scoped row and hides board-wide banner", async ({
    page,
  }) => {
    // Intercept maintenance API to return single agent maintenance window
    await page.route("**/api/myrmidon/maintenance", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          active: true,
          instance: null,
          windows: [
            {
              id: "w-eng-17",
              scope: { type: "agent", id: agentId },
              companyId,
              state: "on",
              reason: "bot container profile update (adm-dev-eng-17)",
              drainTimeoutSec: 60,
              onTimeout: "wait",
              startedAt: new Date().toISOString(),
              onAt: new Date().toISOString(),
              drainDeadlineAt: new Date().toISOString(),
              drainTimedOut: false,
              exitRequestedAt: null,
              runningRuns: 0,
              queuedRuns: 0,
              queuedWakeups: 0,
              interruptedRuns: 0,
            },
          ],
        }),
      });
    });

    await page.goto(`/${prefix}/issues`);

    // Common red banner is not present
    await expect(page.getByTestId("myrmidon-maintenance-banner")).toHaveCount(0);

    // Row with agent name is present
    const scopedBanner = page.getByTestId("myrmidon-maintenance-scoped-banner");
    await expect(scopedBanner).toBeVisible();
    await expect(scopedBanner).toContainText(agentName);
    const link = scopedBanner.getByRole("link");
    await expect(link).toBeVisible();
  });

  test("mocked agent maintenance window displays Russian discrete scoped row with Russian locale", async ({
    page,
  }) => {
    const agentId = "adm-dev-eng-17";
    const agentName = "adm-dev-eng-17";
    const companyId = "company-mock-ru";
    const prefix = "e2e-scoped-ru";

    await page.addInitScript(() => {
      window.localStorage.setItem("myrmidon:ui-language", "ru");
      window.localStorage.setItem("myrmidon.ui2.locale", "ru");
    });

    await page.route("**/api/companies/current", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          id: companyId,
          name: "E2E Scoped Company RU",
          issuePrefix: prefix,
        }),
      });
    });

    await page.route("**/api/companies", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify([
          { id: companyId, name: "E2E Scoped Company RU", issuePrefix: prefix },
        ]),
      });
    });

    await page.route(`**/api/companies/${companyId}/agents`, async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify([
          { id: agentId, name: agentName, role: "engineer", status: "active" },
        ]),
      });
    });

    await page.route("**/api/myrmidon/maintenance", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          active: true,
          instance: null,
          windows: [
            {
              id: "w-eng-17",
              scope: { type: "agent", id: agentId },
              companyId,
              state: "on",
              reason: "bot container profile update (adm-dev-eng-17)",
              drainTimeoutSec: 60,
              onTimeout: "wait",
              startedAt: new Date().toISOString(),
              onAt: new Date().toISOString(),
              drainDeadlineAt: new Date().toISOString(),
              drainTimedOut: false,
              exitRequestedAt: null,
              runningRuns: 0,
              queuedRuns: 0,
              queuedWakeups: 0,
              interruptedRuns: 0,
            },
          ],
        }),
      });
    });

    await page.goto(`/${prefix}/issues`);

    await expect(page.getByTestId("myrmidon-maintenance-banner")).toHaveCount(0);

    const scopedBanner = page.getByTestId("myrmidon-maintenance-scoped-banner");
    await expect(scopedBanner).toBeVisible();
    await expect(scopedBanner).toContainText("Обновляется контейнер бота");
    await expect(scopedBanner).toContainText(agentName);
    await expect(scopedBanner).toContainText("(~1 мин), остальная доска работает");
    const link = scopedBanner.getByRole("link");
    await expect(link).toBeVisible();
  });

  test("mocked multiple bot containers display Russian plural scoped banner with count 7", async ({
    page,
  }) => {
    const companyId = "company-mock-plural-ru";
    const prefix = "e2e-plural-ru";

    await page.addInitScript(() => {
      window.localStorage.setItem("myrmidon:ui-language", "ru");
      window.localStorage.setItem("myrmidon.ui2.locale", "ru");
    });

    await page.route("**/api/companies/current", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          id: companyId,
          name: "E2E Scoped Company Plural RU",
          issuePrefix: prefix,
        }),
      });
    });

    await page.route("**/api/companies", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify([
          { id: companyId, name: "E2E Scoped Company Plural RU", issuePrefix: prefix },
        ]),
      });
    });

    await page.route(`**/api/companies/${companyId}/agents`, async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify([]),
      });
    });

    const windows = Array.from({ length: 7 }, (_, i) => ({
      id: `w-eng-${i + 1}`,
      scope: { type: "agent", id: `adm-dev-eng-${i + 1}` },
      companyId,
      state: "on",
      reason: `bot container profile update (adm-dev-eng-${i + 1})`,
      drainTimeoutSec: 60,
      onTimeout: "wait",
      startedAt: new Date().toISOString(),
      onAt: new Date().toISOString(),
      drainDeadlineAt: new Date().toISOString(),
      drainTimedOut: false,
      exitRequestedAt: null,
      runningRuns: 0,
      queuedRuns: 0,
      queuedWakeups: 0,
      interruptedRuns: 0,
    }));

    await page.route("**/api/myrmidon/maintenance", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          active: true,
          instance: null,
          windows,
        }),
      });
    });

    await page.goto(`/${prefix}/issues`);

    await expect(page.getByTestId("myrmidon-maintenance-banner")).toHaveCount(0);

    const scopedBanner = page.getByTestId("myrmidon-maintenance-scoped-banner");
    await expect(scopedBanner).toBeVisible();
    await expect(scopedBanner).toHaveText("Обновляются контейнеры ботов (7) (~1 мин), остальная доска работает");
  });

  test("mocked department maintenance window displays Russian discrete scoped row", async ({
    page,
  }) => {
    const companyId = "company-mock-dept-ru";
    const prefix = "e2e-dept-ru";

    await page.addInitScript(() => {
      window.localStorage.setItem("myrmidon:ui-language", "ru");
      window.localStorage.setItem("myrmidon.ui2.locale", "ru");
    });

    await page.route("**/api/companies/current", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          id: companyId,
          name: "E2E Scoped Company Dept RU",
          issuePrefix: prefix,
        }),
      });
    });

    await page.route("**/api/companies", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify([
          { id: companyId, name: "E2E Scoped Company Dept RU", issuePrefix: prefix },
        ]),
      });
    });

    await page.route("**/api/myrmidon/maintenance", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          active: true,
          instance: null,
          windows: [
            {
              id: "w-dept-1",
              scope: { type: "department", id: "dept-engineering" },
              companyId,
              state: "on",
              reason: "department routine upgrade",
              drainTimeoutSec: 60,
              onTimeout: "wait",
              startedAt: new Date().toISOString(),
              onAt: new Date().toISOString(),
              drainDeadlineAt: new Date().toISOString(),
              drainTimedOut: false,
              exitRequestedAt: null,
              runningRuns: 0,
              queuedRuns: 0,
              queuedWakeups: 0,
              interruptedRuns: 0,
            },
          ],
        }),
      });
    });

    await page.goto(`/${prefix}/issues`);

    await expect(page.getByTestId("myrmidon-maintenance-banner")).toHaveCount(0);

    const scopedBanner = page.getByTestId("myrmidon-maintenance-scoped-banner");
    await expect(scopedBanner).toBeVisible();
    await expect(scopedBanner).toHaveText("Обслуживается проект (~1 мин), остальная доска работает");
  });
});
