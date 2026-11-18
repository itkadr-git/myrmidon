import assert from "node:assert/strict";
import { test } from "node:test";
import { componentDigests } from "./release-body.mjs";

const fixtures = [
  { label: "board", repository: "myrmidon", digest: `sha256:${"1".repeat(64)}` },
  { label: "dockergate", repository: "myrmidon-dockergate", digest: `sha256:${"2".repeat(64)}` },
  { label: "fleetd", repository: "myrmidon-fleetd", digest: `sha256:${"3".repeat(64)}` },
  { label: "bot", repository: "myrmidon-hermes", digest: `sha256:${"4".repeat(64)}` },
  { label: "hermes-dev", repository: "myrmidon-hermes-dev", digest: `sha256:${"5".repeat(64)}` },
  { label: "hermes-node", repository: "myrmidon-hermes-node", digest: `sha256:${"6".repeat(64)}` },
];

const expectedRows = [
  `| board | \`ghcr.io/itkadr-git/myrmidon@${fixtures[0].digest}\` |`,
  `| dockergate | \`ghcr.io/itkadr-git/myrmidon-dockergate@${fixtures[1].digest}\` |`,
  `| fleetd | \`ghcr.io/itkadr-git/myrmidon-fleetd@${fixtures[2].digest}\` |`,
  `| bot | \`ghcr.io/itkadr-git/myrmidon-hermes@${fixtures[3].digest}\` |`,
  `| hermes-dev | \`ghcr.io/itkadr-git/myrmidon-hermes-dev@${fixtures[4].digest}\` |`,
  `| hermes-node | \`ghcr.io/itkadr-git/myrmidon-hermes-node@${fixtures[5].digest}\` |`,
];
const expectedDigests = {
  board: { repository: "ghcr.io/itkadr-git/myrmidon", digest: fixtures[0].digest },
  dockergate: { repository: "ghcr.io/itkadr-git/myrmidon-dockergate", digest: fixtures[1].digest },
  fleetd: { repository: "ghcr.io/itkadr-git/myrmidon-fleetd", digest: fixtures[2].digest },
  bot: { repository: "ghcr.io/itkadr-git/myrmidon-hermes", digest: fixtures[3].digest },
  "hermes-dev": { repository: "ghcr.io/itkadr-git/myrmidon-hermes-dev", digest: fixtures[4].digest },
  "hermes-node": { repository: "ghcr.io/itkadr-git/myrmidon-hermes-node", digest: fixtures[5].digest },
};

async function check(absent, missing) {
  const state = Object.freeze(Object.fromEntries(
    fixtures.filter(({ label }) => !absent.includes(label)).map(({ repository, digest }) => [repository, digest]),
  ));
  const snapshot = { ...state };
  let fetchCalls = 0;
  const fetchImpl = () => { fetchCalls += 1; throw new Error("unexpected network access"); };
  const result = await componentDigests("1.7.0", { registryState: state, fetchImpl });
  assert.deepEqual(result.missing, missing);
  assert.deepEqual(result.rows, expectedRows.filter((_, index) => !absent.includes(fixtures[index].label)));
  assert.deepEqual(result.digests, Object.fromEntries(
    Object.entries(expectedDigests).filter(([label]) => !absent.includes(label)),
  ));
  assert.deepEqual(state, snapshot);
  assert.equal(fetchCalls, 0);
  return { result, state, fetchImpl, fetchCount: () => fetchCalls };
}

test("required images: every single absence and pair retain ordered results", async () => {
  const required = ["board", "dockergate", "fleetd", "bot"];
  for (let i = 0; i < required.length; i += 1) {
    await check([required[i]], [required[i]]);
    for (let j = i + 1; j < required.length; j += 1) {
      await check([required[i], required[j]], [required[i], required[j]]);
    }
  }
});

test("optional images: all four presence combinations and all required absent", async () => {
  await check([], []);
  await check(["hermes-dev"], []);
  await check(["hermes-node"], []);
  await check(["hermes-dev", "hermes-node"], []);
  await check(["board", "dockergate", "fleetd", "bot"], ["board", "dockergate", "fleetd", "bot"]);
  await check(fixtures.map(({ label }) => label), ["board", "dockergate", "fleetd", "bot"]);
});

test("frozen offline state and returned values do not leak into the next call", async () => {
  const { result, state, fetchImpl, fetchCount } = await check([], []);
  result.rows.length = 0;
  result.missing.push("board");
  result.digests.board.digest = "changed";
  const next = await componentDigests("1.7.0-rc.1", { registryState: state, fetchImpl });
  assert.deepEqual(next, { rows: expectedRows, missing: [], digests: expectedDigests });
  assert.equal(fetchCount(), 0);
});
