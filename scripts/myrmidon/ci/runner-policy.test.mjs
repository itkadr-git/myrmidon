import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const CI_WORKFLOW = path.join(ROOT, ".github", "workflows", "myrmidon-ci.yml");
const TAG_WORKFLOW = path.join(ROOT, ".github", "workflows", "myrmidon-ci-tag.yml");

describe("CI runner and concurrency policy (OPE-7965)", () => {
  const ciContent = fs.readFileSync(CI_WORKFLOW, "utf8");
  const tagContent = fs.readFileSync(TAG_WORKFLOW, "utf8");

  it("concurrency cancels superseded runs only on PRs, preserving main and merge_group", () => {
    // Only PR runs may be cancelled when superseded; runs on main and
    // merge_group must run to completion so CI status is never lost.
    assert.match(
      ciContent,
      /cancel-in-progress:\s*\$\{\{\s*github\.event_name\s*==\s*'pull_request'/m,
      "cancel-in-progress must only be active for pull_request events",
    );
  });

  it("PR jobs support runner override via CI_RUNNER_PR and dedicated lane variables", () => {
    // PR test lane supports CI_RUNNER_AFFECTED or CI_RUNNER_PR
    assert.match(
      ciContent,
      /tests-affected:[\s\S]*?runs-on:\s*\$\{\{\s*fromJSON\(\s*vars\.CI_RUNNER_AFFECTED\s*\|\|\s*vars\.CI_RUNNER_PR/,
      "tests-affected must allow runner override via CI_RUNNER_AFFECTED or CI_RUNNER_PR",
    );

    // typecheck supports CI_RUNNER_TYPECHECK or CI_RUNNER_PR
    assert.match(
      ciContent,
      /typecheck:[\s\S]*?runs-on:\s*\$\{\{\s*fromJSON\(\s*vars\.CI_RUNNER_TYPECHECK\s*\|\|\s*vars\.CI_RUNNER_PR/,
      "typecheck must allow runner override via CI_RUNNER_PR",
    );

    // checks supports CI_RUNNER_CHECKS or CI_RUNNER_PR
    assert.match(
      ciContent,
      /checks:[\s\S]*?runs-on:\s*\$\{\{\s*fromJSON\(\s*vars\.CI_RUNNER_CHECKS\s*\|\|\s*vars\.CI_RUNNER_PR/,
      "checks must allow runner override via CI_RUNNER_PR",
    );

    // dockergate supports CI_RUNNER_DOCKERGATE or CI_RUNNER_PR
    assert.match(
      ciContent,
      /dockergate[\s\S]*?runs-on:\s*\$\{\{\s*fromJSON\(\s*vars\.CI_RUNNER_DOCKERGATE\s*\|\|\s*vars\.CI_RUNNER_PR/,
      "dockergate must allow runner override via CI_RUNNER_PR",
    );

    // plan supports CI_RUNNER_LIGHT or CI_RUNNER_PR
    assert.match(
      ciContent,
      /plan:[\s\S]*?runs-on:\s*\$\{\{\s*fromJSON\(\s*vars\.CI_RUNNER_LIGHT\s*\|\|\s*vars\.CI_RUNNER_PR/,
      "plan must allow runner override via CI_RUNNER_LIGHT or CI_RUNNER_PR",
    );

    // ci-result supports CI_RUNNER_LIGHT or CI_RUNNER_PR
    assert.match(
      ciContent,
      /ci-result:[\s\S]*?runs-on:\s*\$\{\{\s*fromJSON\(\s*vars\.CI_RUNNER_LIGHT\s*\|\|\s*vars\.CI_RUNNER_PR/,
      "ci-result must allow runner override via CI_RUNNER_LIGHT or CI_RUNNER_PR",
    );
  });

  it("pnpm install steps across CI workflows use --prefer-offline to accelerate self-hosted runs", () => {
    const ciInstalls = [...ciContent.matchAll(/run:\s*pnpm install[^\n]*/g)].map((m) => m[0]);
    assert.ok(ciInstalls.length >= 6, `expected at least 6 pnpm install steps in myrmidon-ci.yml, found ${ciInstalls.length}`);
    for (const step of ciInstalls) {
      assert.match(step, /--prefer-offline/, `CI step "${step}" must carry --prefer-offline`);
    }

    const tagInstalls = [...tagContent.matchAll(/run:\s*pnpm install[^\n]*/g)].map((m) => m[0]);
    assert.ok(tagInstalls.length >= 6, `expected at least 6 pnpm install steps in myrmidon-ci-tag.yml, found ${tagInstalls.length}`);
    for (const step of tagInstalls) {
      assert.match(step, /--prefer-offline/, `Tag CI step "${step}" must carry --prefer-offline`);
    }
  });
});
