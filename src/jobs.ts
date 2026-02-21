import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync } from "fs";
import { appendFileSync } from "fs";

const LOG_FILE = process.env.LOG_FILE || "./agent.log";
function log(msg: string) {
  const line = `[${new Date().toISOString()}] [jobs] ${msg}`;
  console.log(line);
  try { appendFileSync(LOG_FILE, line + "\n"); } catch {}
}

const BRAIN_DIR = process.env.BRAIN_DIR || "/data/brain";
const JOBS_FILE = `${BRAIN_DIR}/jobs.json`;

// ── Types ──

export interface Job {
  id: string;                    // "job_" + timestamp
  type: "todo" | "job" | "system";
  status: "pending" | "queued" | "running" | "completed" | "failed" | "cancelled";
  title: string;                 // Short description
  description: string;           // Full description / instructions
  toolId?: string;               // Reference to tool from registry (for "job" type)
  containerId?: string;          // Docker container ID while running
  createdAt: number;
  startedAt?: number;
  completedAt?: number;
  command?: string;              // Shell command to execute (for job type)
  result?: {
    success: boolean;
    output: string;              // stdout/stderr captured
    artifacts?: string[];        // file paths of outputs
    error?: string;
  };
  output?: string;               // Captured stdout/stderr
  exitCode?: number;             // Process exit code
  source: "whatsapp" | "dashboard" | "brain" | "system";  // who created it
  scheduledFor?: number;         // optional: run at specific time
}

export interface JobStore {
  jobs: Job[];
}

// ── Persistence ──

function ensureDir(): void {
  if (!existsSync(BRAIN_DIR)) {
    mkdirSync(BRAIN_DIR, { recursive: true });
  }
}

export function loadJobs(): JobStore {
  try {
    if (existsSync(JOBS_FILE)) {
      return JSON.parse(readFileSync(JOBS_FILE, "utf-8"));
    }
  } catch (err) {
    log(`Failed to load jobs: ${err}`);
  }
  return { jobs: [] };
}

export function saveJobs(store: JobStore): void {
  ensureDir();
  const tmp = JOBS_FILE + ".tmp";
  writeFileSync(tmp, JSON.stringify(store, null, 2));
  renameSync(tmp, JOBS_FILE);
}

// ── Job Operations ──

export function createJob(params: {
  type: Job["type"];
  title: string;
  description: string;
  source: Job["source"];
  toolId?: string;
  scheduledFor?: number;
}): Job {
  const store = loadJobs();
  const job: Job = {
    id: `job_${Date.now()}`,
    type: params.type,
    status: "pending",
    title: params.title,
    description: params.description,
    toolId: params.toolId,
    source: params.source,
    scheduledFor: params.scheduledFor,
    createdAt: Date.now(),
  };
  store.jobs.push(job);
  saveJobs(store);
  log(`Created job: ${job.id} — ${job.title.slice(0, 80)}`);
  return job;
}

export function getJob(id: string): Job | undefined {
  const store = loadJobs();
  return store.jobs.find(j => j.id === id);
}

export function getJobsByType(type: Job["type"]): Job[] {
  const store = loadJobs();
  return store.jobs.filter(j => j.type === type);
}

export function getJobsByStatus(status: Job["status"]): Job[] {
  const store = loadJobs();
  return store.jobs.filter(j => j.status === status);
}

export function updateJob(id: string, updates: Partial<Job>): Job {
  const store = loadJobs();
  const job = store.jobs.find(j => j.id === id);
  if (!job) throw new Error(`Job not found: ${id}`);
  Object.assign(job, updates);
  saveJobs(store);
  log(`Updated job: ${id} — ${JSON.stringify(updates).slice(0, 120)}`);
  return job;
}

export function cancelJob(id: string): Job {
  const store = loadJobs();
  const job = store.jobs.find(j => j.id === id);
  if (!job) throw new Error(`Job not found: ${id}`);
  job.status = "cancelled";
  job.completedAt = Date.now();
  saveJobs(store);
  log(`Cancelled job: ${id} — ${job.title}`);
  return job;
}

export function getJobStats(): Record<string, Record<string, number>> {
  const store = loadJobs();
  const byType: Record<string, number> = {};
  const byStatus: Record<string, number> = {};

  for (const job of store.jobs) {
    byType[job.type] = (byType[job.type] || 0) + 1;
    byStatus[job.status] = (byStatus[job.status] || 0) + 1;
  }

  return { byType, byStatus };
}

export function cleanupOldJobs(maxAgeDays: number): number {
  const store = loadJobs();
  const cutoff = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000;
  const before = store.jobs.length;

  store.jobs = store.jobs.filter(j => {
    // Only remove completed, failed, or cancelled jobs older than cutoff
    if (j.status === "completed" || j.status === "failed" || j.status === "cancelled") {
      const endTime = j.completedAt || j.createdAt;
      return endTime > cutoff;
    }
    return true; // keep active jobs regardless of age
  });

  const removed = before - store.jobs.length;
  if (removed > 0) {
    saveJobs(store);
    log(`Cleaned up ${removed} old jobs (maxAge=${maxAgeDays}d)`);
  }
  return removed;
}
