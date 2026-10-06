import assert from "node:assert/strict";
import fs from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

// Guards for the Myrmidon image: reproducible CLI versions, no media tools,
// and a publish workflow that never runs for pull requests.

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const dockerfile = fs.readFileSync(path.join(ROOT, "Dockerfile"), "utf8");
const workflow = fs.readFileSync(path.join(ROOT, ".github/workflows/myrmidon-image.yml"), "utf8");

function stage(name) {
  const start = dockerfile.search(new RegExp(`^FROM .* AS ${name}$`, "m"));
  assert.ok(start >= 0, `stage ${name} exists`);
  const rest = dockerfile.slice(start + 1);
  const next = rest.search(/^FROM /m);
  return next < 0 ? rest : rest.slice(0, next);
}

describe("Dockerfile production stage", () => {
  const production = stage("production");
  const install = production.split("\n").find((line) => line.includes("npm install --global"));

  it("installs every agent CLI at a pinned version", () => {
    assert.ok(install, "global npm install line exists");
    assert.doesNotMatch(install, /@latest\b/);
    const packages = install
      .replace(/.*npm install --global\s+(--\S+\s+)*/, "")
      .replace(/\\\s*$/, "")
      .trim()
      .split(/\s+/);
    for (const spec of packages) {
      assert.match(spec, /^(@[^/\s]+\/)?[^@\s]+@\$\{[A-Z_]+_VERSION\}$/, `${spec} is pinned through a build arg`);
      const arg = spec.match(/\$\{([A-Z_]+)\}/)[1];
      assert.match(production, new RegExp(`^ARG ${arg}=\\d+\\.\\d+\\.\\d+$`, "m"), `${arg} has an exact default`);
    }
  });

  it("carries no media tools", () => {
    assert.doesNotMatch(dockerfile, /\b(ffmpeg|ffprobe|yt-dlp|youtube-dl)\b/i);
  });
});

describe("myrmidon-image.yml", () => {
  it("never builds for pull requests and only in this repository", () => {
    assert.doesNotMatch(workflow, /^\s*pull_request(_target)?\s*:/m);
    assert.match(workflow, /if: \$\{\{ github\.repository == 'itkadr-git\/myrmidon' \}\}/);
  });

  it("builds amd64 only and publishes to the Myrmidon namespace", () => {
    assert.match(workflow, /platforms: linux\/amd64\n/);
    assert.match(workflow, /IMAGE: ghcr\.io\/itkadr-git\/myrmidon\n/);
    assert.doesNotMatch(workflow, /paperclipai\/paperclip|ghcr\.io\/\$\{\{ github\.repository \}\}/);
  });

  it("tags sha-<short>, main and the own semver release tag (myr-vX.Y.Z -> X.Y.Z)", () => {
    assert.match(workflow, /type=sha,prefix=sha-,format=short/);
    assert.match(workflow, /type=raw,value=main,enable=\$\{\{ github\.ref == 'refs\/heads\/main' \}\}/);
    assert.match(workflow, /tags: \["myr-v\*"\]/);
    assert.match(workflow, /type=raw,value=\$\{\{ steps\.version\.outputs\.image_tag \}\}/);
    assert.doesNotMatch(workflow, /-myr\./);
  });
});

// RC-TAGS: every release image workflow accepts myr-vX.Y.Z-rc.N and
// still rejects anything else; none of them publishes `latest` or a floating tag.
describe("release candidate tags in the image workflows", () => {
  const files = [
    "myrmidon-image", "myrmidon-dockergate", "myrmidon-fleetd", "myrmidon-bot-image",
    "myrmidon-media-tools", "myrmidon-cloud-files", "myrmidon-image-mcp",
  ];
  const accepts = (regex, value) =>
    spawnSync("bash", ["-c", `[[ "$1" =~ ${regex} ]]`, "_", value]).status === 0;

  for (const name of files) {
    it(`${name}.yml: tag regex takes X.Y.Z and X.Y.Z-rc.N only; no latest/X.Y tag`, () => {
      const text = fs.readFileSync(path.join(ROOT, `.github/workflows/${name}.yml`), "utf8");
      const regexes = [...text.matchAll(/\[\[ ! "\$tag" =~ (\S+) \]\]/g)].map((m) => m[1]);
      assert.ok(regexes.length >= 1, "a tag regex exists");
      const prefix = name === "myrmidon-image" ? "myr-v" : "v";
      for (const regex of regexes) {
        assert.ok(accepts(regex, `${prefix}1.7.0`), regex);
        assert.ok(accepts(regex, `${prefix}1.7.0-rc.3`), regex);
        assert.ok(!accepts(regex, `${prefix}1.7.0-rc`), regex);
        assert.ok(!accepts(regex, `${prefix}1.7.0-beta.1`), regex);
        assert.ok(!accepts(regex, `${prefix}1.7`), regex);
      }
      assert.doesNotMatch(text, /type=raw,value=latest|latest=true|type=semver|type=ref,event=tag/);
    });
  }
});
