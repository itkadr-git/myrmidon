import { afterEach, expect, it, vi } from "vitest";
import { waitForReady } from "./helpers/api-process-harness.js";

afterEach(() => vi.unstubAllGlobals());

it("waits for startup recovery rather than accepting a starting health response", async () => {
  const fetchMock = vi.fn()
    .mockResolvedValueOnce(new Response(JSON.stringify({ status: "starting" }), { status: 200 }))
    .mockResolvedValueOnce(new Response(JSON.stringify({ status: "ok" }), { status: 200 }));
  vi.stubGlobal("fetch", fetchMock);

  await waitForReady({ baseUrl: "http://localhost", alive: () => true, output: () => "" }, 5_000);

  expect(fetchMock).toHaveBeenCalledTimes(2);
});
