import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { findPrivateIps } from "./scan-diff.mjs";
import { scanLine } from "./scan-text.mjs";

const ip = (...octets) => octets.join(".");

const cases = [
  ["10/8 lower neighbor", ip(9, 255, 255, 255), []],
  ["10/8 first", ip(10, 0, 0, 0), ["10/8"]],
  ["10/8 last", ip(10, 255, 255, 255), ["10/8"]],
  ["10/8 upper neighbor", ip(11, 0, 0, 0), []],
  ["172.16/12 lower neighbor", ip(172, 15, 255, 255), []],
  ["172.16/12 first", ip(172, 16, 0, 0), ["172.16/12"]],
  ["172.16/12 last", ip(172, 31, 255, 255), ["172.16/12"]],
  ["172.16/12 upper neighbor", ip(172, 32, 0, 0), []],
  ["192.168/16 lower neighbor", ip(192, 167, 255, 255), []],
  ["192.168/16 first", ip(192, 168, 0, 0), ["192.168/16"]],
  ["192.168/16 last", ip(192, 168, 255, 255), ["192.168/16"]],
  ["192.168/16 upper neighbor", ip(192, 169, 0, 0), []],
  ["CGNAT lower neighbor", ip(100, 63, 255, 255), []],
  ["CGNAT first", ip(100, 64, 0, 0), ["100.64/10"]],
  ["CGNAT last", ip(100, 127, 255, 255), ["100.64/10"]],
  ["CGNAT upper neighbor", ip(100, 128, 0, 0), []],
  ["invalid octet", ip(10, 256, 0, 1), []],
  ["short address", ip(10, 1, 2), []],
  ["five component version", `v${ip(1, 10, 1, 2, 3)}`, []],
  ["two different private addresses", `${ip(192, 168, 1, 1)} ${ip(10, 2, 3, 4)}`, ["192.168/16", "10/8"]],
];

describe("private IPv4 boundary contract", () => {
  for (const [name, text, expected] of cases) {
    it(name, () => {
      assert.deepEqual(findPrivateIps(text), expected);
      assert.deepEqual(
        scanLine(text, 17, [], []),
        expected.map((range) => ({ line: 17, rule: `private address in ${range}` })),
      );
    });
  }
});
