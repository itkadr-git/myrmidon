import assert from "node:assert/strict";
import { test } from "node:test";

import { resolveNativeRunnerRequirement } from "../../dev-runner-native-binary.mjs";

const cases = [
  ["last false overrides earlier true", 0, '{"nativeRunnerRequired":true}\n{"nativeRunnerRequired":false}', false, true],
  ["last true overrides earlier false", 0, '{"nativeRunnerRequired":false}\n{"nativeRunnerRequired":true}', true, true],
  ["malformed last line preserves false", 0, '{"nativeRunnerRequired":false}\n{"nativeRunnerRequired":', false, true],
  ["malformed last line preserves true", 0, '{"nativeRunnerRequired":true}\n{broken}', true, true],
  ["missing field preserves false", 0, '{"nativeRunnerRequired":false}\n{"other":true}', false, true],
  ["missing field preserves true", 0, '{"nativeRunnerRequired":true}\n{}', true, true],
  ["CRLF and whitespace preserve false", 0, '  {"nativeRunnerRequired":false}  \r\n   \r\n', false, true],
  ["CRLF and whitespace preserve true", 0, '\t{"nativeRunnerRequired":true}\t\r\n', true, true],
  ["pnpm logs around false are ignored", 0, 'pnpm warning\n{"nativeRunnerRequired":false}\n> package build\nDone', false, true],
  ["pnpm logs around true are ignored", 0, '> pnpm status\n{"nativeRunnerRequired":true}\nwarning: text', true, true],
  ["string is not a boolean", 0, '{"nativeRunnerRequired":"false"}', true, false],
  ["number is not a boolean", 0, '{"nativeRunnerRequired":0}', true, false],
  ["null is not a boolean", 0, '{"nativeRunnerRequired":null}', true, false],
  ["non-booleans after valid false are ignored", 0, '{"nativeRunnerRequired":false}\n{"nativeRunnerRequired":"true"}\n{"nativeRunnerRequired":1}\n{"nativeRunnerRequired":null}', false, true],
  ["empty output fails safe", 0, '', true, false],
  ["malformed output alone fails safe", 0, '{bad}\n{"nativeRunnerRequired":', true, false],
  ["failed process rejects valid false", 1, '{"nativeRunnerRequired":false}', true, false],
  ["failed process rejects valid true", 2, '{"nativeRunnerRequired":true}', true, false],
  ["mixed output selects latest valid false", 0, 'pnpm log\n{"nativeRunnerRequired":true}\n{bad}\n{"nativeRunnerRequired":false}\n{}\n{"nativeRunnerRequired":null}', false, true],
  ["mixed output selects latest valid true", 0, 'pnpm log\n{"nativeRunnerRequired":false}\n{bad}\n{"nativeRunnerRequired":true}\n{}\n{"nativeRunnerRequired":"false"}', true, true],
];

for (const [name, exitCode, stdout, nativeRunnerRequired, valid] of cases) {
  test(name, () => {
    const input = Object.freeze({ exitCode, stdout });
    const original = { ...input };
    const result = resolveNativeRunnerRequirement(input);
    assert.deepStrictEqual(result, { nativeRunnerRequired, valid });
    assert.deepStrictEqual(input, original);
  });
}
