/**
 * Pluggable Channel Adapter Pattern.
 *
 * Defines a common interface for all messaging integrations (WhatsApp, Slack,
 * Twilio, etc.). New channels implement ChannelAdapter and register themselves.
 *
 * Inspired by OpenClaw's star topology where each channel is a pluggable node
 * connecting through a central gateway. This abstraction allows:
 * - Adding new channels without modifying core brain logic
 * - Uniform message send/receive across all channels
 * - Channel-specific capabilities declared via feature flags
 * - Centralized channel health monitoring
 *
 * Current channels continue to work as-is — this adapter layer wraps them
 * without requiring immediate migration. New channels should implement this
 * interface directly.
 */

import { createLogger } from "../logger.js";

const log = createLogger("channels");

// ── Types ──

export type ChannelId = "whatsapp" | "slack" | "twilio" | "gmail" | "telegram" | "signal" | (string & {});

export interface InboundMessage {
  channelId: ChannelId;
  senderJid: string;
  senderName: string;
  text: string;
  timestamp: number;
  isGroup: boolean;
  groupName?: string;
  isFromMe: boolean;
  mediaType?: "voice" | "image" | "document";
  mediaBuffer?: Buffer;
  mediaMimetype?: string;
  threadId?: string;
  replyToMessageId?: string;
  metadata?: Record<string, unknown>;
}

export interface OutboundMessage {
  channelId: ChannelId;
  recipientJid: string;
  text: string;
  replyToMessageId?: string;
  threadId?: string;
  metadata?: Record<string, unknown>;
}

export interface DeliveryResult {
  success: boolean;
  messageId?: string;
  error?: string;
  timestamp: number;
}

export type ChannelFeature =
  | "text"          // basic text messaging
  | "voice"         // voice message support
  | "image"         // image sharing
  | "document"      // document/file sharing
  | "groups"        // group conversations
  | "threads"       // threaded replies
  | "reactions"     // message reactions
  | "read_receipts" // read receipt tracking
  | "typing"        // typing indicators
  | "presence";     // online/offline status

export interface ChannelStatus {
  channelId: ChannelId;
  connected: boolean;
  lastMessageAt: number;
  errorCount: number;
  lastError?: string;
}

// ── Channel Adapter Interface ──

export interface ChannelAdapter {
  /** Unique channel identifier */
  readonly id: ChannelId;

  /** Human-readable channel name */
  readonly name: string;

  /** Features this channel supports */
  readonly features: ReadonlySet<ChannelFeature>;

  /** Send a message through this channel */
  send(message: OutboundMessage): Promise<DeliveryResult>;

  /** Check if channel is currently connected and healthy */
  getStatus(): ChannelStatus;

  /** Start the channel (connect, begin polling, etc.) */
  start(): Promise<void>;

  /** Stop the channel gracefully */
  stop(): Promise<void>;
}

// ── Channel Registry ──

const channels = new Map<ChannelId, ChannelAdapter>();

/**
 * Register a channel adapter. Called during integration startup.
 */
export function registerChannel(adapter: ChannelAdapter): void {
  if (channels.has(adapter.id)) {
    log(`Channel ${adapter.id} already registered — replacing`);
  }
  channels.set(adapter.id, adapter);
  log(`Channel registered: ${adapter.name} (${adapter.id}) — features: ${[...adapter.features].join(", ")}`);
}

/**
 * Unregister a channel adapter.
 */
export function unregisterChannel(channelId: ChannelId): void {
  channels.delete(channelId);
}

/**
 * Get a registered channel adapter by ID.
 */
export function getChannel(channelId: ChannelId): ChannelAdapter | undefined {
  return channels.get(channelId);
}

/**
 * Get all registered channel adapters.
 */
export function getAllChannels(): ReadonlyMap<ChannelId, ChannelAdapter> {
  return channels;
}

/**
 * Send a message through the appropriate channel.
 * Resolves the channel from the message's channelId.
 */
export async function sendViaChannel(message: OutboundMessage): Promise<DeliveryResult> {
  const adapter = channels.get(message.channelId);
  if (!adapter) {
    return {
      success: false,
      error: `No adapter registered for channel: ${message.channelId}`,
      timestamp: Date.now(),
    };
  }

  try {
    return await adapter.send(message);
  } catch (err) {
    log(`Channel ${message.channelId} send threw: ${err}`);
    return { success: false, error: String(err), timestamp: Date.now() };
  }
}

/**
 * Stop all registered channels and clear the registry.
 * Call during process shutdown to ensure clean teardown.
 */
export async function stopAllChannels(): Promise<void> {
  const errors: Array<{ id: string; error: unknown }> = [];
  for (const [id, adapter] of channels) {
    try {
      await adapter.stop();
    } catch (err) {
      errors.push({ id, error: err });
      log(`Failed to stop channel ${id}: ${err}`);
    }
  }
  channels.clear();
  if (errors.length > 0) {
    log(`Stopped all channels with ${errors.length} error(s)`);
  } else {
    log("All channels stopped cleanly");
  }
}

/**
 * Get health status for all registered channels.
 */
export function getChannelHealth(): ChannelStatus[] {
  return [...channels.values()].map(ch => ch.getStatus());
}

/**
 * Check if a specific feature is supported by a channel.
 */
export function channelSupports(channelId: ChannelId, feature: ChannelFeature): boolean {
  const adapter = channels.get(channelId);
  return adapter?.features.has(feature) ?? false;
}
