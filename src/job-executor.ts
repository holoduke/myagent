import { readFileSync, appendFileSync, existsSync, mkdirSync, writeFileSync } from "fs";
import { execSync, spawn, ChildProcess } from "child_process";
import { loadJobs, saveJobs, updateJob, getJobsByStatus, type Job } from "./jobs.js";
import { loadRegistry, registerTool, getToolByName, updateTool, markUsed, type Tool } from "./tool-registry.js";

// ── Logging ──

const LOG_FILE = process.env.LOG_FILE || "./agent.log";
function log(msg: string) {
  const line = `[${new Date().toISOString()}] [job-executor] ${msg}`;
  console.log(line);
  try { appendFileSync(LOG_FILE, line + "\n"); } catch {}
}

// ── Config ──

const TICK_INTERVAL = 30_000; // 30 seconds
const JOB_TIMEOUT = 10 * 60 * 1000; // 10 minutes
const OUTPUT_LIMIT = 5000; // max chars of captured output
const WORKSPACE_ROOT = "/data/jobs/workspace";
const DEFAULT_IMAGE = "node:20-slim";

// ── State ──

let executorInterval: ReturnType<typeof setInterval> | null = null;
let currentProcess: ChildProcess | null = null;
let currentJobId: string | null = null;
let running = false;

// ── Public API ──

export function startJobExecutor(): void {
  if (executorInterval) {
    log("Job executor already running");
    return;
  }

  if (!isDockerAvailable()) {
    log("Docker is not available — job executor will not start");
    return;
  }

  running = true;
  log(`Job executor starting (polling every ${TICK_INTERVAL / 1000}s, timeout ${JOB_TIMEOUT / 60000}min)`);

  executorInterval = setInterval(() => {
    tick().catch((err) => {
      log(`Tick error: ${err}`);
    });
  }, TICK_INTERVAL);

  // Run initial tick after a short delay
  setTimeout(() => {
    tick().catch((err) => {
      log(`Initial tick error: ${err}`);
    });
  }, 5000);
}

export function stopJobExecutor(): void {
  if (executorInterval) {
    clearInterval(executorInterval);
    executorInterval = null;
  }

  running = false;

  // Gracefully stop any running container
  if (currentJobId) {
    const containerName = `aria-job-${currentJobId}`;
    log(`Stopping running container: ${containerName}`);
    try {
      execSync(`docker stop ${containerName}`, { timeout: 15000, stdio: "pipe" });
    } catch {
      // Container may have already exited
      try {
        execSync(`docker kill ${containerName}`, { timeout: 5000, stdio: "pipe" });
      } catch {
        // Nothing more we can do
      }
    }
  }

  currentProcess = null;
  currentJobId = null;
  log("Job executor stopped");
}

export function getExecutorStatus(): {
  running: boolean;
  currentJob: string | null;
  dockerAvailable: boolean;
  queueLength: number;
} {
  let queueLength = 0;
  try {
    queueLength = getJobsByStatus("queued").length;
  } catch {
    // Jobs file may not exist yet
  }

  return {
    running,
    currentJob: currentJobId,
    dockerAvailable: isDockerAvailable(),
    queueLength,
  };
}

// ── Docker helpers ──

export function isDockerAvailable(): boolean {
  try {
    execSync("docker version", { timeout: 5000, stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

function imageExists(imageName: string): boolean {
  try {
    execSync(`docker image inspect ${imageName}`, { timeout: 10000, stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

function ensureWorkspaceDir(jobId: string): string {
  const dir = `${WORKSPACE_ROOT}/${jobId}`;
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  return dir;
}

function truncateOutput(output: string): string {
  if (output.length <= OUTPUT_LIMIT) return output;
  return "...[truncated]\n" + output.slice(-OUTPUT_LIMIT);
}

// ── Tick ──

async function tick(): Promise<void> {
  // Don't pick up new work if we're already running a job
  if (currentJobId) return;

  const queued = getJobsByStatus("queued");
  if (queued.length === 0) return;

  const next = queued[0];
  log(`Found queued job: ${next.id} — ${(next.description || "").slice(0, 80)}`);

  try {
    await executeJob(next);
  } catch (err) {
    log(`Unhandled error executing job ${next.id}: ${err}`);
    try {
      updateJob(next.id, {
        status: "failed",
        completedAt: Date.now(),
        output: truncateOutput(`Executor error: ${err}`),
      });
    } catch (updateErr) {
      log(`Failed to update job ${next.id} after error: ${updateErr}`);
    }
    currentJobId = null;
    currentProcess = null;
  }
}

// ── Core execution ──

export async function executeJob(job: Job): Promise<void> {
  currentJobId = job.id;

  // Mark as running
  updateJob(job.id, {
    status: "running",
    startedAt: Date.now(),
  });
  log(`Job ${job.id} status -> running`);

  // Determine execution mode
  let tool: Tool | undefined;
  if (job.toolId) {
    const { getTool } = await import("./tool-registry.js");
    tool = getTool(job.toolId) || getToolByName(job.toolId);
    if (!tool) {
      log(`Job ${job.id} references unknown tool: ${job.toolId}`);
      updateJob(job.id, {
        status: "failed",
        completedAt: Date.now(),
        output: `Tool not found: ${job.toolId}`,
      });
      currentJobId = null;
      return;
    }
  }

  // If no tool and no runnable command, skip for brain planning
  if (!tool && !job.command) {
    log(`Job ${job.id} has no tool and no command — skipping (needs brain planning)`);
    updateJob(job.id, {
      status: "queued",
      startedAt: undefined,
    });
    currentJobId = null;
    return;
  }

  const workspaceDir = ensureWorkspaceDir(job.id);

  try {
    let result: { exitCode: number; output: string };

    if (tool) {
      result = await executeToolJob(job, tool, workspaceDir);
    } else {
      result = await executeSimpleJob(job, workspaceDir);
    }

    const status = result.exitCode === 0 ? "completed" : "failed";
    updateJob(job.id, {
      status,
      completedAt: Date.now(),
      output: truncateOutput(result.output),
      exitCode: result.exitCode,
    });
    log(`Job ${job.id} status -> ${status} (exit ${result.exitCode})`);

    // If tool was used, mark it as recently used
    if (tool) {
      try { markUsed(tool.id); } catch {}
    }
  } catch (err) {
    updateJob(job.id, {
      status: "failed",
      completedAt: Date.now(),
      output: truncateOutput(`Execution error: ${err}`),
    });
    log(`Job ${job.id} failed with error: ${err}`);
  } finally {
    currentJobId = null;
    currentProcess = null;
  }
}

// ── Tool-based job execution ──

async function executeToolJob(
  job: Job,
  tool: Tool,
  workspaceDir: string,
): Promise<{ exitCode: number; output: string }> {
  const imageName = tool.imageName || `aria-tool-${tool.name}`;

  // Build the image if it doesn't exist
  if (!imageExists(imageName)) {
    log(`Image ${imageName} not found — building`);
    const built = await buildToolImage(tool);
    if (!built) {
      return { exitCode: 1, output: `Failed to build image for tool: ${tool.name}` };
    }
  }

  const command = job.command || tool.defaultCommand || "";
  return runContainer(job.id, imageName, command, workspaceDir);
}

// ── Simple job execution (no tool, just a command) ──

async function executeSimpleJob(
  job: Job,
  workspaceDir: string,
): Promise<{ exitCode: number; output: string }> {
  const command = job.command || "";
  return runContainer(job.id, DEFAULT_IMAGE, command, workspaceDir);
}

// ── Container runner ──

function runContainer(
  jobId: string,
  imageName: string,
  command: string,
  workspaceDir: string,
): Promise<{ exitCode: number; output: string }> {
  return new Promise((resolve) => {
    const containerName = `aria-job-${jobId}`;
    const args = [
      "run", "--rm",
      "--name", containerName,
      "-v", `${workspaceDir}:/workspace`,
      "-w", "/workspace",
      "--network", "none",
      "--memory", "512m",
      "--cpus", "1",
      imageName,
      ...parseCommand(command),
    ];

    log(`Running: docker ${args.join(" ")}`);

    const child = spawn("docker", args, {
      stdio: ["ignore", "pipe", "pipe"],
    });
    currentProcess = child;

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (data: Buffer) => {
      stdout += data.toString();
    });

    child.stderr.on("data", (data: Buffer) => {
      stderr += data.toString();
    });

    // Timeout guard
    const timer = setTimeout(() => {
      log(`Job ${jobId} timed out after ${JOB_TIMEOUT / 1000}s — killing container`);
      try {
        execSync(`docker kill ${containerName}`, { timeout: 10000, stdio: "pipe" });
      } catch {
        // Container may have already stopped
      }
    }, JOB_TIMEOUT);

    child.on("close", (code: number | null) => {
      clearTimeout(timer);
      currentProcess = null;
      const combined = stdout + (stderr ? `\n--- stderr ---\n${stderr}` : "");
      resolve({
        exitCode: code ?? 1,
        output: combined,
      });
    });

    child.on("error", (err: Error) => {
      clearTimeout(timer);
      currentProcess = null;
      resolve({
        exitCode: 1,
        output: `Spawn error: ${err.message}`,
      });
    });
  });
}

/**
 * Parse a command string into an array of arguments.
 * Handles basic shell-style quoting.
 */
function parseCommand(command: string): string[] {
  if (!command.trim()) return [];

  // Use /bin/sh -c to handle shell features like pipes, redirects, etc.
  return ["/bin/sh", "-c", command];
}

// ── Image builder ──

export async function buildToolImage(tool: Tool): Promise<boolean> {
  const imageName = tool.imageName || `aria-tool-${tool.name}`;
  const buildDir = `/tmp/aria-build-${tool.name}-${Date.now()}`;

  try {
    mkdirSync(buildDir, { recursive: true });

    // Write the Dockerfile
    const dockerfile = tool.dockerfile;
    if (!dockerfile) {
      log(`Tool ${tool.name} has no dockerfile — cannot build`);
      updateTool(tool.id, { status: "failed" });
      return false;
    }
    writeFileSync(`${buildDir}/Dockerfile`, dockerfile);

    // Write any extra files the tool might need
    if (tool.buildFiles) {
      for (const [filename, contents] of Object.entries(tool.buildFiles)) {
        writeFileSync(`${buildDir}/${filename}`, contents);
      }
    }

    log(`Building image ${imageName} from ${buildDir}`);

    return new Promise((resolve) => {
      const child = spawn("docker", ["build", "-t", imageName, "."], {
        cwd: buildDir,
        stdio: ["ignore", "pipe", "pipe"],
      });

      let buildLog = "";

      child.stdout.on("data", (data: Buffer) => {
        buildLog += data.toString();
      });

      child.stderr.on("data", (data: Buffer) => {
        buildLog += data.toString();
      });

      // Build timeout: 5 minutes
      const timer = setTimeout(() => {
        log(`Build of ${imageName} timed out — killing`);
        child.kill("SIGKILL");
      }, 5 * 60 * 1000);

      child.on("close", (code: number | null) => {
        clearTimeout(timer);
        // Clean up build directory
        try {
          execSync(`rm -rf ${buildDir}`, { timeout: 5000, stdio: "pipe" });
        } catch {}

        if (code === 0) {
          log(`Image ${imageName} built successfully`);
          try {
            updateTool(tool.id, { status: "ready", imageName });
          } catch {}
          resolve(true);
        } else {
          log(`Image ${imageName} build failed (exit ${code})`);
          log(`Build log (last 2000 chars): ${buildLog.slice(-2000)}`);
          try {
            updateTool(tool.id, {
              status: "failed",
              buildLog: truncateOutput(buildLog),
            });
          } catch {}
          resolve(false);
        }
      });

      child.on("error", (err: Error) => {
        clearTimeout(timer);
        log(`Build spawn error for ${imageName}: ${err.message}`);
        try {
          updateTool(tool.id, { status: "failed" });
        } catch {}
        resolve(false);
      });
    });
  } catch (err) {
    log(`buildToolImage error for ${tool.name}: ${err}`);
    try {
      updateTool(tool.id, { status: "failed" });
    } catch {}
    return false;
  }
}
