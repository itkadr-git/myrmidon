import { DiscordFormatConverter } from "@chat-adapter/discord";
import { describe, expect, it } from "vitest";
import { discordMarkdownRequiresAttachment } from "./chat-discord.js";

const converter = new DiscordFormatConverter();
const render = (markdown: string) => converter.renderPostable({ markdown });

async function expectBoundary(text: string, length: number, attachment: boolean) {
  expect(render(text).length).toBe(length);
  await expect(discordMarkdownRequiresAttachment(text)).resolves.toBe(attachment);
}

describe("Discord formatted UTF-16 message boundaries", () => {
  it("uses the inclusive 2000-unit limit for ASCII", async () => {
    for (const length of [1999, 2000, 2001]) {
      await expectBoundary("x".repeat(length), length, length > 2000);
    }
  });

  it("counts both UTF-16 units of each surrogate pair", async () => {
    await expectBoundary("\u{1f642}".repeat(1000), 2000, false);
    await expectBoundary("\u{1f642}".repeat(1001), 2002, true);
  });

  it("uses the expanded mention length on both sides of the limit", async () => {
    const mention = " @a";
    const expansion = render(`x${mention}`).length - 1;
    expect(expansion).toBeGreaterThan(mention.length);
    for (const length of [1999, 2000, 2001]) {
      const text = `${"x".repeat(length - expansion)}${mention}`;
      expect(text.length).toBeLessThan(length);
      await expectBoundary(text, length, length > 2000);
    }
  });

  it("measures formatted fenced code at and above the limit", async () => {
    const makeCode = (count: number) => `\`\`\`ts\n${"x".repeat(count)}\n\`\`\``;
    const overhead = render(makeCode(1)).length - 1;
    for (const length of [2000, 2001]) {
      await expectBoundary(makeCode(length - overhead), length, length > 2000);
    }
  });

  it("returns the same decisions for repeated and parallel calls", async () => {
    const inputs = ["x".repeat(2000), "x".repeat(2001), "\u{1f642}".repeat(1000), "\u{1f642}".repeat(1001)];
    const expected = [false, true, false, true];
    expect(await Promise.all(inputs.map(discordMarkdownRequiresAttachment))).toEqual(expected);
    for (let i = 0; i < inputs.length; i++) {
      await expect(discordMarkdownRequiresAttachment(inputs[i]!)).resolves.toBe(expected[i]);
    }
    expect(await Promise.all(inputs.map(discordMarkdownRequiresAttachment))).toEqual(expected);
  });
});
