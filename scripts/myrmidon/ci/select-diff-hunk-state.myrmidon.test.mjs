import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { detectExportOrTypeChangesFromDiff } from "./select.mjs";

describe("diff export and type hunk state", () => {
  const cases = [
    ["detects added export", `diff --git a/src/a.ts b/src/a.ts
@@ -1 +1 @@
+export const value = 1;`, ["src/a.ts"]],
    ["detects removed export", `diff --git a/src/a.ts b/src/a.ts
@@ -1 +1 @@
-export const value = 1;`, ["src/a.ts"]],
    ["ignores added export comments", `diff --git a/src/a.ts b/src/a.ts
@@ -1 +1 @@
+// export const value = 1;
+/* export const other = 2; */`, []],
    ["ignores ordinary changed code", `diff --git a/src/a.ts b/src/a.ts
@@ -1 +1 @@
+const value = 1;`, []],
    ["detects change in interface hunk", `diff --git a/src/a.ts b/src/a.ts
@@ -1,2 +1,2 @@ interface User {
-  name: string;
+  name: number;`, ["src/a.ts"]],
    ["detects change in type hunk", `diff --git a/src/a.ts b/src/a.ts
@@ -1,2 +1,2 @@ type User = {
+  name: string;`, ["src/a.ts"]],
    ["ignores comments within interface hunk", `diff --git a/src/a.ts b/src/a.ts
@@ -1,2 +1,2 @@ interface User {
+  // name changed`, []],
    ["resets type state at ordinary hunk", `diff --git a/src/a.ts b/src/a.ts
@@ -1,2 +1,2 @@ type User = {
+  // comment only
@@ -10 +10 @@ function run() {
+  return 1;`, []],
    ["detects type state after ordinary hunk", `diff --git a/src/a.ts b/src/a.ts
@@ -1 +1 @@ function run() {
+  return 1;
@@ -10 +10 @@ interface User {
+  name: string;`, ["src/a.ts"]],
    ["does not inherit type state across files", `diff --git a/src/a.ts b/src/a.ts
@@ -1 +1 @@ interface User {
+  // comment only
diff --git a/src/b.ts b/src/b.ts
@@ -1 +1 @@ function run() {
+  return 1;`, []],
    ["resets type state at file boundary before any next hunk", `diff --git a/src/a.ts b/src/a.ts
@@ -1 +1 @@ interface User {
+  // comment only
diff --git a/src/b.ts b/src/b.ts
+  return 1;`, []],
    ["detects type state in the next file", `diff --git a/src/a.ts b/src/a.ts
@@ -1 +1 @@ function run() {
+  return 1;
diff --git a/src/b.ts b/src/b.ts
@@ -1 +1 @@ interface User {
+  name: string;`, ["src/b.ts"]],
    ["excludes test files", `diff --git a/src/a.test.ts b/src/a.test.ts
@@ -1 +1 @@
+export const a = 1;
diff --git a/src/b.spec.ts b/src/b.spec.ts
@@ -1 +1 @@
+export const b = 1;
diff --git a/src/__tests__/c.ts b/src/__tests__/c.ts
@@ -1 +1 @@
+export const c = 1;`, []],
    ["includes a non-test file beside excluded files", `diff --git a/src/a.test.ts b/src/a.test.ts
@@ -1 +1 @@
+export const a = 1;
diff --git a/src/a.ts b/src/a.ts
@@ -1 +1 @@
+export const a = 1;`, ["src/a.ts"]],
    ["excludes markdown", `diff --git a/docs/a.md b/docs/a.md
@@ -1 +1 @@
+export const a = 1;`, []],
    ["returns one path for repeated changes to a file", `diff --git a/src/a.ts b/src/a.ts
@@ -1 +1 @@
+export const a = 1;
@@ -10 +10 @@
+export const b = 2;
diff --git a/src/a.ts b/src/a.ts
@@ -20 +20 @@
+export const c = 3;`, ["src/a.ts"]],
    ["preserves first-seen file order", `diff --git a/src/z.ts b/src/z.ts
@@ -1 +1 @@
+export const z = 1;
diff --git a/src/a.ts b/src/a.ts
@@ -1 +1 @@
+export const a = 1;`, ["src/z.ts", "src/a.ts"]],
    ["returns no files for an empty diff", "", []],
  ];

  for (const [name, diff, expected] of cases) {
    it(name, () => {
      assert.deepEqual(detectExportOrTypeChangesFromDiff(diff), expected);
    });
  }
});
