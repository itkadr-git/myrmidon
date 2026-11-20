import assert from "node:assert/strict";
import test from "node:test";
import { parseJsonResponseWithLimit } from "../dev-runner-output.mjs";

const bytes = (text) => new TextEncoder().encode(text);
const deferred = () => {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
};

function fixture(chunks, { pauseAt, error } = {}) {
  const trace = [];
  const snapshots = chunks.map((chunk) => Array.from(chunk));
  const arrived = deferred();
  const release = deferred();
  let index = 0;
  let closed = false;
  const stream = new ReadableStream({
    async pull(controller) {
      trace.push(`pull:${index}`);
      assert.equal(closed, false, "read after EOF");
      if (index === pauseAt) {
        arrived.resolve();
        await release.promise;
      }
      if (index === chunks.length) {
        closed = true;
        if (error) controller.error(error);
        else controller.close();
      } else {
        controller.enqueue(chunks[index++]);
      }
    },
    cancel(reason) { trace.push(["cancel", reason]); },
  }, { highWaterMark: 0 });
  const response = new Response(stream);
  return {
    response, trace, arrived: arrived.promise, release: release.resolve,
    verify() {
      assert.equal(response.body.locked, false);
      assert.deepEqual(chunks.map((chunk) => Array.from(chunk)), snapshots);
    },
  };
}

function expectSuccess(result, value) {
  assert.equal(result.status, "fulfilled", `expected successful parse: ${result.reason}`);
  assert.deepEqual(result.value, value);
}

test("concurrent decoders retain partial Unicode independently", async () => {
  const encoded = bytes('"\u{1f600}"');
  const a = fixture([encoded.subarray(0, 2), encoded.subarray(2)], { pauseAt: 1 });
  const b = fixture([bytes('{"other":'), bytes('42}')]);
  const pa = parseJsonResponseWithLimit(a.response, 6);
  const pb = parseJsonResponseWithLimit(b.response, 12);
  const settledA = Promise.allSettled([pa]);
  const settledB = Promise.allSettled([pb]);
  try {
    await a.arrived;
    const [resultB] = await settledB;
    expectSuccess(resultB, { other: 42 });
    a.release();
    const [resultA] = await settledA;
    expectSuccess(resultA, "\u{1f600}");
    assert.deepEqual(b.trace, ["pull:0", "pull:1", "pull:2"]);
    a.verify(); b.verify();
  } finally {
    a.release();
    await Promise.allSettled([settledA, settledB]);
  }
});

for (const failure of ["overflow", "reader error"]) {
  test(`${failure} in A does not cancel or corrupt B, and C remains usable`, async () => {
    const controlledError = new Error("controlled reader failure");
    const a = failure === "overflow"
      ? fixture([bytes('1234'), bytes('5'), bytes('6')], { pauseAt: 1 })
      : fixture([bytes('1')], { pauseAt: 1, error: controlledError });
    const b = fixture([bytes('[1,'), bytes('2]')], { pauseAt: 1 });
    const settledA = Promise.allSettled([parseJsonResponseWithLimit(a.response, 4)]);
    const settledB = Promise.allSettled([parseJsonResponseWithLimit(b.response, 5)]);
    try {
      await Promise.all([a.arrived, b.arrived]);
      a.release();
      const [resultA] = await settledA;
      assert.equal(resultA.status, "rejected");
      if (failure === "overflow") {
        assert.equal(resultA.reason.message, "Response exceeds 4 bytes");
        assert.deepEqual(a.trace, ["pull:0", "pull:1", ["cancel", "response too large"]]);
      } else {
        assert.equal(resultA.reason, controlledError);
        assert.deepEqual(a.trace, ["pull:0", "pull:1"]);
      }
      b.release();
      const [resultB] = await settledB;
      expectSuccess(resultB, [1, 2]);
      assert.deepEqual(b.trace, ["pull:0", "pull:1", "pull:2"]);
      const c = fixture([bytes('7')]);
      const [resultC] = await Promise.allSettled([parseJsonResponseWithLimit(c.response, 1)]);
      expectSuccess(resultC, 7);
      c.verify(); a.verify(); b.verify();
    } finally {
      a.release(); b.release();
      await Promise.allSettled([settledA, settledB]);
    }
  });
}
