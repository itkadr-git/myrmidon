/**
 * Guards for the decisions inside the pgvector deb shim (`test-pgvector.ts`).
 *
 * The shim cannot be exercised end to end without a linux x64 host, network access and the embedded
 * cluster, so its decision points — which environment the archive tools receive, which member of the
 * deb carries the payload, how that member is unpacked, and what a failed command reports — are pure
 * functions and are pinned here. The end-to-end path (extension installed, `CREATE EXTENSION vector`
 * accepted, both rankings executing) is covered by the integration suite on CI, where the shim either
 * stages pgvector or states the exact reason it could not.
 */
import { describe, expect, it } from "vitest";

import {
  childProcessErrorDetail,
  extractionEnv,
  pickDebDataMember,
  tarFlagsForDataMember,
} from "./test-pgvector.js";

describe("extractionEnv", () => {
  it("drops the loader paths so the system xz does not load the embedded liblzma", () => {
    const clean = extractionEnv({
      PATH: "/usr/bin",
      LD_LIBRARY_PATH: "/repo/node_modules/@embedded-postgres/linux-x64/native/lib",
      DYLD_LIBRARY_PATH: "/repo/node_modules/@embedded-postgres/darwin-x64/native/lib",
    });

    expect(clean.LD_LIBRARY_PATH).toBeUndefined();
    expect(clean.DYLD_LIBRARY_PATH).toBeUndefined();
    expect(clean.PATH).toBe("/usr/bin");
  });

  it("returns a copy, leaving the caller's environment untouched", () => {
    const source = { LD_LIBRARY_PATH: "/somewhere/lib", HOME: "/root" };
    const clean = extractionEnv(source);

    expect(source.LD_LIBRARY_PATH).toBe("/somewhere/lib");
    expect(clean).not.toBe(source);
    expect(clean.HOME).toBe("/root");
  });

  it("is happy when the variables were never set", () => {
    const clean = extractionEnv({ CI: "true" });

    expect(clean.LD_LIBRARY_PATH).toBeUndefined();
    expect(clean.CI).toBe("true");
  });
});

describe("pickDebDataMember", () => {
  it("takes the payload member from an ar listing regardless of its compression", () => {
    const listing = "debian-binary\ncontrol.tar.xz\ndata.tar.xz\n";

    expect(pickDebDataMember(listing)).toBe("data.tar.xz");
    expect(pickDebDataMember("debian-binary\ncontrol.tar.zst\ndata.tar.zst\n")).toBe("data.tar.zst");
    expect(pickDebDataMember("debian-binary\ncontrol.tar.gz\ndata.tar.gz\n")).toBe("data.tar.gz");
    expect(pickDebDataMember("debian-binary\ndata.tar\n")).toBe("data.tar");
  });

  it("tolerates padding, carriage returns and blank lines", () => {
    expect(pickDebDataMember("  debian-binary \r\n\r\ncontrol.tar.xz\r\n data.tar.xz \r\n")).toBe(
      "data.tar.xz",
    );
  });

  it("never mistakes the control member for the payload", () => {
    expect(pickDebDataMember("debian-binary\ncontrol.tar.xz\n")).toBeNull();
  });

  it("reports a deb without a payload member instead of guessing a name", () => {
    expect(pickDebDataMember("")).toBeNull();
    expect(pickDebDataMember("debian-binary\n")).toBeNull();
  });
});

describe("tarFlagsForDataMember", () => {
  it("maps the compression of each member to the matching tar invocation", () => {
    expect(tarFlagsForDataMember("data.tar.xz")).toEqual(["xJf"]);
    expect(tarFlagsForDataMember("data.tar.gz")).toEqual(["xzf"]);
    expect(tarFlagsForDataMember("data.tar.zst")).toEqual(["--zstd", "xf"]);
    expect(tarFlagsForDataMember("data.tar")).toEqual(["xf"]);
  });

  it("refuses a compression it cannot unpack, rather than extracting garbage", () => {
    expect(tarFlagsForDataMember("data.tar.bz2")).toBeNull();
    expect(tarFlagsForDataMember("data.tar.lzma")).toBeNull();
  });
});

describe("childProcessErrorDetail", () => {
  it("keeps the stderr that explains the failure", () => {
    const error = Object.assign(new Error("Command failed: tar xJf /tmp/deb/data.tar.xz -C /tmp/x"), {
      stderr: "xz: /native/lib/liblzma.so.5: version `XZ_5.4' not found\n",
    });

    const detail = childProcessErrorDetail(error);

    expect(detail).toContain("Command failed: tar xJf");
    expect(detail).toContain("version `XZ_5.4' not found");
  });

  it("reads stderr from a buffer and ignores an empty one", () => {
    const buffered = Object.assign(new Error("Command failed: ar t deb"), {
      stderr: Buffer.from("ar: deb: No such file or directory\n", "utf8"),
    });
    const silent = Object.assign(new Error("Command failed: ar t deb"), { stderr: "   \n" });

    expect(childProcessErrorDetail(buffered)).toContain("No such file or directory");
    expect(childProcessErrorDetail(silent)).toBe("Command failed: ar t deb");
  });

  it("still describes a thrown value that is not an Error", () => {
    expect(childProcessErrorDetail("boom")).toBe("boom");
  });
});