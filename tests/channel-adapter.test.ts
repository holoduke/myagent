/**
 * Tests for the pluggable channel adapter pattern.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import type { ChannelAdapter, ChannelFeature, OutboundMessage, DeliveryResult, ChannelStatus } from "../backend/integrations/channel-adapter.js";
import {
  registerChannel,
  unregisterChannel,
  getChannel,
  getAllChannels,
  sendViaChannel,
  getChannelHealth,
  channelSupports,
  stopAllChannels,
} from "../backend/integrations/channel-adapter.js";

// Test adapter factory
function createTestAdapter(
  id: string,
  name: string,
  features: ChannelFeature[] = ["text"],
  overrides?: {
    sendResult?: Partial<DeliveryResult>;
    sendThrows?: Error;
    stopThrows?: Error;
  },
): ChannelAdapter {
  return {
    id,
    name,
    features: new Set(features),
    send: async (_msg: OutboundMessage): Promise<DeliveryResult> => {
      if (overrides?.sendThrows) throw overrides.sendThrows;
      return {
        success: true,
        messageId: `msg_${Date.now()}`,
        timestamp: Date.now(),
        ...overrides?.sendResult,
      };
    },
    getStatus: (): ChannelStatus => ({
      channelId: id,
      connected: true,
      lastMessageAt: Date.now(),
      errorCount: 0,
    }),
    start: async () => {},
    stop: async () => {
      if (overrides?.stopThrows) throw overrides.stopThrows;
    },
  };
}

describe("Channel Adapter Pattern", () => {
  beforeEach(async () => {
    // Clean up all registered channels safely
    const ids = Array.from(getAllChannels().keys());
    for (const id of ids) {
      unregisterChannel(id);
    }
  });

  describe("registerChannel", () => {
    it("registers a new channel adapter", () => {
      const adapter = createTestAdapter("test-wa", "WhatsApp Test");
      registerChannel(adapter);
      expect(getChannel("test-wa")).toBe(adapter);
    });

    it("replaces existing adapter with same id", () => {
      const adapter1 = createTestAdapter("test-ch", "Channel V1");
      const adapter2 = createTestAdapter("test-ch", "Channel V2");
      registerChannel(adapter1);
      registerChannel(adapter2);
      expect(getChannel("test-ch")?.name).toBe("Channel V2");
    });
  });

  describe("unregisterChannel", () => {
    it("removes a registered channel", () => {
      const adapter = createTestAdapter("test-rm", "Remove Me");
      registerChannel(adapter);
      unregisterChannel("test-rm");
      expect(getChannel("test-rm")).toBeUndefined();
    });

    it("handles unregistering non-existent channel gracefully", () => {
      expect(() => unregisterChannel("nonexistent")).not.toThrow();
    });
  });

  describe("getAllChannels", () => {
    it("returns all registered channels", () => {
      registerChannel(createTestAdapter("ch1", "Channel 1"));
      registerChannel(createTestAdapter("ch2", "Channel 2"));
      const all = getAllChannels();
      expect(all.size).toBe(2);
      expect(all.has("ch1")).toBe(true);
      expect(all.has("ch2")).toBe(true);
    });

    it("returns empty map when no channels registered", () => {
      expect(getAllChannels().size).toBe(0);
    });
  });

  describe("sendViaChannel", () => {
    it("sends message through registered channel", async () => {
      registerChannel(createTestAdapter("test-send", "Send Test"));
      const result = await sendViaChannel({
        channelId: "test-send",
        recipientJid: "user@test",
        text: "Hello",
      });
      expect(result.success).toBe(true);
      expect(result.messageId).toBeDefined();
    });

    it("returns error for unregistered channel", async () => {
      const result = await sendViaChannel({
        channelId: "nonexistent",
        recipientJid: "user@test",
        text: "Hello",
      });
      expect(result.success).toBe(false);
      expect(result.error).toContain("No adapter registered");
    });

    it("propagates send failures from adapter result", async () => {
      registerChannel(createTestAdapter("fail-ch", "Failing", ["text"], {
        sendResult: { success: false, error: "Connection refused" },
      }));
      const result = await sendViaChannel({
        channelId: "fail-ch",
        recipientJid: "user@test",
        text: "Hello",
      });
      expect(result.success).toBe(false);
      expect(result.error).toBe("Connection refused");
    });

    it("catches exceptions thrown by adapter.send() and returns DeliveryResult", async () => {
      registerChannel(createTestAdapter("throw-ch", "Thrower", ["text"], {
        sendThrows: new Error("network timeout"),
      }));
      const result = await sendViaChannel({
        channelId: "throw-ch",
        recipientJid: "user@test",
        text: "Hello",
      });
      expect(result.success).toBe(false);
      expect(result.error).toContain("network timeout");
      expect(result.timestamp).toBeGreaterThan(0);
    });
  });

  describe("channelSupports", () => {
    it("returns true for supported features", () => {
      registerChannel(createTestAdapter("feat-ch", "Feature Test", ["text", "voice", "image"]));
      expect(channelSupports("feat-ch", "text")).toBe(true);
      expect(channelSupports("feat-ch", "voice")).toBe(true);
      expect(channelSupports("feat-ch", "image")).toBe(true);
    });

    it("returns false for unsupported features", () => {
      registerChannel(createTestAdapter("basic-ch", "Basic", ["text"]));
      expect(channelSupports("basic-ch", "voice")).toBe(false);
      expect(channelSupports("basic-ch", "threads")).toBe(false);
    });

    it("returns false for unregistered channel", () => {
      expect(channelSupports("ghost-ch", "text")).toBe(false);
    });
  });

  describe("getChannelHealth", () => {
    it("returns health for all channels", () => {
      registerChannel(createTestAdapter("h1", "Health 1"));
      registerChannel(createTestAdapter("h2", "Health 2"));
      const health = getChannelHealth();
      expect(health).toHaveLength(2);
      expect(health.every(h => h.connected)).toBe(true);
    });

    it("returns empty array when no channels", () => {
      expect(getChannelHealth()).toHaveLength(0);
    });
  });

  describe("stopAllChannels", () => {
    it("stops all channels and clears registry", async () => {
      registerChannel(createTestAdapter("s1", "Stop 1"));
      registerChannel(createTestAdapter("s2", "Stop 2"));
      expect(getAllChannels().size).toBe(2);

      await stopAllChannels();
      expect(getAllChannels().size).toBe(0);
    });

    it("handles stop errors gracefully without leaving channels in registry", async () => {
      registerChannel(createTestAdapter("ok-ch", "OK Channel"));
      registerChannel(createTestAdapter("err-ch", "Error Channel", ["text"], {
        stopThrows: new Error("stop failed"),
      }));

      // Should not throw
      await expect(stopAllChannels()).resolves.toBeUndefined();
      // Registry should still be cleared
      expect(getAllChannels().size).toBe(0);
    });

    it("works on empty registry", async () => {
      await expect(stopAllChannels()).resolves.toBeUndefined();
    });
  });
});
