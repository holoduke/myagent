import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync } from "fs";
import { appendFileSync } from "fs";

const LOG_FILE = process.env.LOG_FILE || "./agent.log";
function log(msg: string) {
  const line = `[${new Date().toISOString()}] [recurring] ${msg}`;
  console.log(line);
  appendFileSync(LOG_FILE, line + "\n");
}

const BRAIN_DIR = process.env.BRAIN_DIR || "/data/brain";
const RECURRING_FILE = `${BRAIN_DIR}/recurring-tasks.json`;

// ── Types ──

export interface RecurringTask {
  id: string;
  type: "message" | "think_trigger" | "digest";
  label: string;
  pattern: { hours: number[]; daysOfWeek?: number[] };
  action:
    | { type: "message"; targetJid: string; template: string }
    | { type: "think_trigger"; topic: string; context?: string }
    | { type: "digest"; targetJid: string };
  enabled: boolean;
  createdAt: number;
  lastRunAt: number;
  source: "brain" | "owner";
}

// ── Persistence ──

function loadTasks(): RecurringTask[] {
  try {
    if (existsSync(RECURRING_FILE)) {
      return JSON.parse(readFileSync(RECURRING_FILE, "utf-8"));
    }
  } catch (err) {
    log(`Failed to load recurring tasks: ${err}`);
  }
  return [];
}

function saveTasks(tasks: RecurringTask[]): void {
  try {
    if (!existsSync(BRAIN_DIR)) {
      mkdirSync(BRAIN_DIR, { recursive: true });
    }
    const tmp = RECURRING_FILE + ".tmp";
    writeFileSync(tmp, JSON.stringify(tasks, null, 2));
    renameSync(tmp, RECURRING_FILE);
  } catch (err) {
    log(`Failed to save recurring tasks: ${err}`);
  }
}

// ── Default Tasks ──

function seedDefaults(ownerJid: string): RecurringTask[] {
  const now = Date.now();
  const defaults: RecurringTask[] = [
    {
      id: "recurring_morning_briefing",
      type: "digest",
      label: "Morning briefing",
      pattern: { hours: [8] }, // Every day at 8am
      action: { type: "digest", targetJid: ownerJid },
      enabled: true,
      createdAt: now,
      lastRunAt: 0,
      source: "owner",
    },
    {
      id: "recurring_evening_briefing",
      type: "digest",
      label: "Evening briefing",
      pattern: { hours: [21] }, // Every day at 9pm
      action: { type: "digest", targetJid: ownerJid },
      enabled: true,
      createdAt: now,
      lastRunAt: 0,
      source: "owner",
    },
    {
      id: "recurring_weekly_reflection",
      type: "think_trigger",
      label: "Weekly review",
      pattern: { hours: [10], daysOfWeek: [0] }, // Sunday at 10am
      action: { type: "think_trigger", topic: "Weekly review: reflect on the past week, notable events, relationship changes, personal growth observations, and plan ahead for the coming week." },
      enabled: true,
      createdAt: now,
      lastRunAt: 0,
      source: "owner",
    },
  ];

  saveTasks(defaults);
  log(`Seeded ${defaults.length} default recurring tasks`);
  return defaults;
}

// ── Scheduling Logic ──

const MIN_RUN_INTERVAL = 50 * 60 * 1000; // 50 minutes minimum between runs

export function isDue(task: RecurringTask, now: Date): boolean {
  if (!task.enabled) return false;

  // Enforce minimum interval since last run
  if (task.lastRunAt > 0 && (now.getTime() - task.lastRunAt) < MIN_RUN_INTERVAL) {
    return false;
  }

  const currentHour = now.getHours();
  const currentDay = now.getDay();

  // Check hour match
  if (!task.pattern.hours.includes(currentHour)) return false;

  // Check day match (if specified)
  if (task.pattern.daysOfWeek && !task.pattern.daysOfWeek.includes(currentDay)) return false;

  return true;
}

export function getDueRecurringTasks(ownerJid: string): RecurringTask[] {
  let tasks = loadTasks();

  // Seed defaults on first boot
  if (tasks.length === 0) {
    tasks = seedDefaults(ownerJid);
  }

  const now = new Date();
  return tasks.filter(t => isDue(t, now));
}

export function markExecuted(taskId: string): void {
  const tasks = loadTasks();
  const task = tasks.find(t => t.id === taskId);
  if (task) {
    task.lastRunAt = Date.now();
    saveTasks(tasks);
    log(`Marked recurring task executed: ${task.label} (${taskId})`);
  }
}

export function getAllRecurringTasks(): RecurringTask[] {
  return loadTasks();
}
