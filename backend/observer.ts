import { appendFileSync, readFileSync, writeFileSync, existsSync, mkdirSync, renameSync } from "fs";
import { createLogger } from "./logger.js";

const log = createLogger("observer");

const BRAIN_DIR = process.env.BRAIN_DIR || "/data/brain";
const OBS_FILE = `${BRAIN_DIR}/observations.jsonl`;
const RETENTION_DAYS = Number(process.env.BRAIN_OBSERVATION_DAYS ?? 7);

export interface EmailMeta {
  from: string;
  to: string;
  subject: string;
  accountId: string;
  accountEmail: string;
  messageId: string;
}

export interface CalendarMeta {
  eventId: string;
  calendarId: string;
  accountEmail: string;
  start: string;
  end: string;
  location?: string;
}

export interface LocationMeta {
  lat: number;
  lon: number;
  accuracy: number;
  battery?: number;
  velocity?: number;
}

export interface Observation {
  timestamp: number;
  sender: string;
  senderJid: string;
  isGroup: boolean;
  groupName?: string;
  isFromMe: boolean;
  text: string;
  chatJid?: string;
  chatName?: string;
  source?: "whatsapp" | "gmail" | "calendar" | "homeassistant" | "rss" | "owntracks";
  emailMeta?: EmailMeta;
  calendarMeta?: CalendarMeta;
  locationMeta?: LocationMeta;
  urgency?: number;
}

export interface ObservationFilter {
  sender?: string;
  source?: Observation["source"];
  isGroup?: boolean;
  isFromMe?: boolean;
  textContains?: string;
}

export function ensureBrainDir(): void {
  if (!existsSync(BRAIN_DIR)) {
    mkdirSync(BRAIN_DIR, { recursive: true });
    log(`Created brain directory: ${BRAIN_DIR}`);
  }
}

export function recordObservation(obs: Observation): void {
  try {
    ensureBrainDir();
    appendFileSync(OBS_FILE, JSON.stringify(obs) + "\n");
  } catch (err) {
    log(`Failed to record observation: ${err}`);
  }
}

export function getObservationsSince(since: number, filter?: ObservationFilter): Observation[] {
  try {
    if (!existsSync(OBS_FILE)) return [];
    const lines = readFileSync(OBS_FILE, "utf-8").split("\n");
    const results: Observation[] = [];
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const obs = JSON.parse(line) as Observation;
        if (obs.timestamp <= since) continue;
        if (filter) {
          if (filter.sender !== undefined && !obs.sender.toLowerCase().includes(filter.sender.toLowerCase())) continue;
          if (filter.source !== undefined && obs.source !== filter.source) continue;
          if (filter.isGroup !== undefined && obs.isGroup !== filter.isGroup) continue;
          if (filter.isFromMe !== undefined && obs.isFromMe !== filter.isFromMe) continue;
          if (filter.textContains !== undefined && !obs.text.toLowerCase().includes(filter.textContains.toLowerCase())) continue;
        }
        results.push(obs);
      } catch {
        // Skip corrupted lines
      }
    }
    return results;
  } catch (err) {
    log(`Failed to read observations: ${err}`);
    return [];
  }
}

export function getObservationCount(since: number): number {
  try {
    if (!existsSync(OBS_FILE)) return 0;
    const lines = readFileSync(OBS_FILE, "utf-8").split("\n");
    let count = 0;
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const obs = JSON.parse(line) as Observation;
        if (obs.timestamp > since) count++;
      } catch {
        // Skip corrupted lines
      }
    }
    return count;
  } catch {
    return 0;
  }
}

export function pruneObservations(days?: number): void {
  const cutoff = Date.now() - (days ?? RETENTION_DAYS) * 86400000;
  try {
    if (!existsSync(OBS_FILE)) return;
    const lines = readFileSync(OBS_FILE, "utf-8").split("\n");
    const kept: string[] = [];
    let pruned = 0;
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const obs = JSON.parse(line) as Observation;
        if (obs.timestamp >= cutoff) {
          kept.push(line);
        } else {
          pruned++;
        }
      } catch {
        // Drop corrupted lines during pruning
        pruned++;
      }
    }
    if (pruned > 0) {
      const tmp = OBS_FILE + ".tmp";
      writeFileSync(tmp, kept.join("\n") + (kept.length ? "\n" : ""));
      renameSync(tmp, OBS_FILE);
      log(`Pruned ${pruned} old observations, kept ${kept.length}`);
    }
  } catch (err) {
    log(`Failed to prune observations: ${err}`);
  }
}
