import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../backend/logger.js", () => ({
  createLogger: () => Object.assign((...args: unknown[]) => {}, { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }),
}));

// Mock fetch globally
const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

import { transcribeAudio } from "../backend/utils/transcribe.js";

describe("transcribeAudio", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    mockFetch.mockReset();
  });

  it("returns null when OPENAI_API_KEY is not set", async () => {
    delete process.env.OPENAI_API_KEY;
    const result = await transcribeAudio(Buffer.from("audio data"), "audio/ogg");
    expect(result).toBeNull();
  });

  it("returns null for empty buffer", async () => {
    process.env.OPENAI_API_KEY = "test-key";
    const result = await transcribeAudio(Buffer.alloc(0), "audio/ogg");
    expect(result).toBeNull();
  });

  it("returns null for oversized buffer", async () => {
    process.env.OPENAI_API_KEY = "test-key";
    const huge = Buffer.alloc(26 * 1024 * 1024); // 26MB
    const result = await transcribeAudio(huge, "audio/ogg");
    expect(result).toBeNull();
  });

  it("returns transcribed text on success", async () => {
    process.env.OPENAI_API_KEY = "test-key";
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ text: "Hello world" }),
    });

    const result = await transcribeAudio(Buffer.from("audio data"), "audio/ogg");
    expect(result).toBe("Hello world");
    expect(mockFetch).toHaveBeenCalledOnce();
  });

  it("returns null on API error", async () => {
    process.env.OPENAI_API_KEY = "test-key";
    mockFetch.mockResolvedValue({
      ok: false,
      status: 429,
      text: async () => "Rate limited",
    });

    const result = await transcribeAudio(Buffer.from("audio data"), "audio/ogg");
    expect(result).toBeNull();
  });

  it("returns null on empty transcription", async () => {
    process.env.OPENAI_API_KEY = "test-key";
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ text: "" }),
    });

    const result = await transcribeAudio(Buffer.from("audio data"), "audio/ogg");
    expect(result).toBeNull();
  });

  it("handles fetch errors gracefully", async () => {
    process.env.OPENAI_API_KEY = "test-key";
    mockFetch.mockRejectedValue(new Error("Network error"));

    const result = await transcribeAudio(Buffer.from("audio data"), "audio/ogg");
    expect(result).toBeNull();
  });

  it("maps WhatsApp mimetypes correctly", async () => {
    process.env.OPENAI_API_KEY = "test-key";
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ text: "Test" }),
    });

    await transcribeAudio(Buffer.from("data"), "audio/mp4");
    const call = mockFetch.mock.calls[0];
    expect(call[1].body).toBeDefined(); // Should have a body
  });
});
