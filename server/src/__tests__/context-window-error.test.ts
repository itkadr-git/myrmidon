import { describe, it, expect, vi, beforeEach } from "vitest";
import { isContextWindowError } from "../services/heartbeat.js";

describe("Context Window Error Detection", () => {
  it("should detect context compression error", () => {
    const message = "Context compression could not bring this session under the model's context window. Start a new session with /new";
    expect(isContextWindowError(message)).toBe(true);
  });

  it("should detect HTTP 400 max bytes error", () => {
    const message = "HTTP 400 … Exceeded limit on max bytes to request body : 16777216";
    expect(isContextWindowError(message)).toBe(true);
  });

  it("should detect context window exceeded error", () => {
    const message = "Error: context window exceeded for this model";
    expect(isContextWindowError(message)).toBe(true);
  });

  it("should detect session too large error", () => {
    const message = "The session too large to process";
    expect(isContextWindowError(message)).toBe(true);
  });

  it("should detect max tokens exceeded error", () => {
    const message = "max tokens exceeded for this request";
    expect(isContextWindowError(message)).toBe(true);
  });

  it("should not detect other errors", () => {
    const message = "Connection timeout";
    expect(isContextWindowError(message)).toBe(false);
  });

  it("should return false for null or undefined", () => {
    expect(isContextWindowError(null)).toBe(false);
    expect(isContextWindowError(undefined)).toBe(false);
  });

  it("should return false for empty string", () => {
    expect(isContextWindowError("")).toBe(false);
  });

  it("should be case insensitive", () => {
    const message = "CONTEXT COMPRESSION COULD NOT BRING THIS SESSION UNDER THE MODEL'S CONTEXT WINDOW";
    expect(isContextWindowError(message)).toBe(true);
  });
});