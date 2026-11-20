import test from "node:test";
import assert from "node:assert/strict";
import { resolveNativeRunnerRequirement } from "../dev-runner-native-binary.mjs";

const cases = [
  ["true on LF", 0, 'log\n{"nativeRunnerRequired":true}\n', true, true],
  ["false on CRLF with whitespace", 0, 'log\r\n {"nativeRunnerRequired":false}  \r\n', false, true],
  ["last false wins", 0, '{"nativeRunnerRequired":true}\n{"nativeRunnerRequired":false}', false, true],
  ["last true wins", 0, '{"nativeRunnerRequired":false}\r\n{"nativeRunnerRequired":true}', true, true],
  ["malformed later line", 0, '{"nativeRunnerRequired":false}\n{"nativeRunnerRequired":', false, true],
  ["null later line", 0, '{"nativeRunnerRequired":false}\nnull', false, true],
  ["array later line", 0, '{"nativeRunnerRequired":false}\n[{"nativeRunnerRequired":true}]', false, true],
  ["string later field", 0, '{"nativeRunnerRequired":false}\n{"nativeRunnerRequired":"true"}', false, true],
  ["number later field", 0, '{"nativeRunnerRequired":false}\n{"nativeRunnerRequired":1}', false, true],
  ["prefixed JSON is a log", 0, '{"nativeRunnerRequired":false}\nlog: {"nativeRunnerRequired":true}', false, true],
  ["prefixed JSON alone fails closed", 0, 'log: {"nativeRunnerRequired":false}', true, false],
  ["no valid JSON fails closed", 0, 'log\nnull\n[]\n{"nativeRunnerRequired":"false"}', true, false],
  ["nonzero exit overrides false", 1, '{"nativeRunnerRequired":false}', true, false],
  ["nonzero exit overrides true", 2, '{"nativeRunnerRequired":true}', true, false],
];

for (const [name, exitCode, stdout, required, valid] of cases) {
  test(name, () => {
    const input = Object.freeze({ exitCode, stdout });
    const result = resolveNativeRunnerRequirement(input);
    assert.deepStrictEqual(result, { nativeRunnerRequired: required, valid });
    assert.deepStrictEqual(input, { exitCode, stdout });
  });
}
