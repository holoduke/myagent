import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync } from "fs";
import { appendFileSync } from "fs";
import type { WorkingMemory } from "./types.js";

const LOG_FILE = process.env.LOG_FILE || "./agent.log";
function log(msg: string) {
  const line = `[${new Date().toISOString()}] [working-memory] ${msg}`;
  console.log(line);
  appendFileSync(LOG_FILE, line + "\n");
}

const BRAIN_DIR = process.env.BRAIN_DIR || "/data/brain";
const WM_FILE = `${BRAIN_DIR}/working-memory.json`;

function defaultWorkingMemory(): WorkingMemory {
  return {
    currentContext: "",
    mood: "neutral",
    shortTermTracking: [],
    activatedNodeIds: [],
    lastUpdated: 0,
  };
}

export function loadWorkingMemory(): WorkingMemory {
  try {
    if (existsSync(WM_FILE)) {
      return { ...defaultWorkingMemory(), ...JSON.parse(readFileSync(WM_FILE, "utf-8")) };
    }
  } catch {
    log("Failed to read working memory, using defaults");
  }
  return defaultWorkingMemory();
}

export function saveWorkingMemory(wm: WorkingMemory): void {
  try {
    if (!existsSync(BRAIN_DIR)) {
      mkdirSync(BRAIN_DIR, { recursive: true });
    }
    const tmp = WM_FILE + ".tmp";
    writeFileSync(tmp, JSON.stringify(wm, null, 2));
    renameSync(tmp, WM_FILE);
  } catch (err) {
    log(`Failed to save working memory: ${err}`);
  }
}

export function updateWorkingMemory(
  wm: WorkingMemory,
  updates: {
    currentContext?: string;
    mood?: string;
    shortTermTracking?: string[];
    activatedNodeIds?: string[];
  },
): WorkingMemory {
  if (updates.currentContext !== undefined) wm.currentContext = updates.currentContext;
  if (updates.mood !== undefined) wm.mood = updates.mood;
  if (updates.shortTermTracking !== undefined) wm.shortTermTracking = updates.shortTermTracking;
  if (updates.activatedNodeIds !== undefined) wm.activatedNodeIds = updates.activatedNodeIds;
  wm.lastUpdated = Date.now();
  return wm;
}
