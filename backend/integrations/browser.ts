import { chromium, Browser, BrowserContext, Page } from "playwright";
import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync } from "fs";
import { randomUUID } from "crypto";
import { createLogger } from "../logger.js";
import { isIntegrationEnabled } from "./integration-config.js";

const log = createLogger("browser");

const BROWSER_DIR = "/data/browser";
const STATE_FILE = `${BROWSER_DIR}/state.json`;
const TASK_HISTORY_FILE = `${BROWSER_DIR}/history.json`;
const MAX_HISTORY = 50;

// ── Types ──

export interface BrowserTask {
  id: string;
  type: "navigate" | "screenshot" | "extract" | "fill" | "click" | "script";
  url?: string;
  selector?: string;
  value?: string;
  script?: string;
  waitFor?: string;
  timeout?: number;
}

export interface BrowserTaskResult {
  id: string;
  taskId: string;
  success: boolean;
  type: BrowserTask["type"];
  url?: string;
  title?: string;
  content?: string;
  screenshotPath?: string;
  error?: string;
  durationMs: number;
  completedAt: number;
}

export interface BrowserState {
  ready: boolean;
  activeSessions: number;
  totalTasks: number;
  lastTaskAt: number;
}

export interface BrowserStatus {
  ready: boolean;
  activeSessions: number;
  totalTasks: number;
  lastTaskAt: number;
  recentTasks: BrowserTaskResult[];
}

// ── State management ──

function ensureDir(): void {
  if (!existsSync(BROWSER_DIR)) {
    mkdirSync(BROWSER_DIR, { recursive: true });
  }
  if (!existsSync(`${BROWSER_DIR}/screenshots`)) {
    mkdirSync(`${BROWSER_DIR}/screenshots`, { recursive: true });
  }
}

function loadState(): BrowserState {
  try {
    if (existsSync(STATE_FILE)) {
      return JSON.parse(readFileSync(STATE_FILE, "utf-8"));
    }
  } catch (err) {
    log(`Failed to load state: ${err}`);
  }
  return { ready: false, activeSessions: 0, totalTasks: 0, lastTaskAt: 0 };
}

function saveState(state: BrowserState): void {
  ensureDir();
  const tmp = STATE_FILE + ".tmp";
  writeFileSync(tmp, JSON.stringify(state, null, 2));
  renameSync(tmp, STATE_FILE);
}

function loadHistory(): BrowserTaskResult[] {
  try {
    if (existsSync(TASK_HISTORY_FILE)) {
      return JSON.parse(readFileSync(TASK_HISTORY_FILE, "utf-8"));
    }
  } catch (err) {
    log(`Failed to load history: ${err}`);
  }
  return [];
}

function saveHistory(history: BrowserTaskResult[]): void {
  ensureDir();
  const trimmed = history.slice(-MAX_HISTORY);
  const tmp = TASK_HISTORY_FILE + ".tmp";
  writeFileSync(tmp, JSON.stringify(trimmed, null, 2));
  renameSync(tmp, TASK_HISTORY_FILE);
}

// ── Browser instance management ──

let browserInstance: Browser | null = null;
let activeSessions = 0;

async function getBrowser(): Promise<Browser> {
  if (browserInstance && browserInstance.isConnected()) {
    return browserInstance;
  }

  log("Launching Chromium headless...");
  browserInstance = await chromium.launch({
    headless: true,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-gpu",
    ],
  });

  browserInstance.on("disconnected", () => {
    log("Browser disconnected");
    browserInstance = null;
  });

  const state = loadState();
  state.ready = true;
  saveState(state);

  log("Chromium launched successfully");
  return browserInstance;
}

async function withPage<T>(fn: (page: Page) => Promise<T>, timeout = 30000): Promise<T> {
  const browser = await getBrowser();
  const context: BrowserContext = await browser.newContext({
    userAgent: "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    viewport: { width: 1280, height: 720 },
  });

  activeSessions++;
  const page = await context.newPage();
  page.setDefaultTimeout(timeout);

  try {
    return await fn(page);
  } finally {
    activeSessions--;
    await context.close().catch(() => {});
  }
}

// ── Task execution ──

async function executeTask(task: BrowserTask): Promise<BrowserTaskResult> {
  const start = Date.now();
  const resultId = randomUUID();

  try {
    switch (task.type) {
      case "navigate": {
        if (!task.url) throw new Error("url is required for navigate");
        const result = await withPage(async (page) => {
          await page.goto(task.url!, { waitUntil: "domcontentloaded", timeout: task.timeout ?? 30000 });
          if (task.waitFor) await page.waitForSelector(task.waitFor, { timeout: 10000 });
          const title = await page.title();
          const content = await page.evaluate(() => document.body?.innerText?.slice(0, 5000) || "");
          return { title, content, url: page.url() };
        }, task.timeout);

        return {
          id: resultId, taskId: task.id, success: true, type: task.type,
          url: result.url, title: result.title, content: result.content,
          durationMs: Date.now() - start, completedAt: Date.now(),
        };
      }

      case "screenshot": {
        if (!task.url) throw new Error("url is required for screenshot");
        const screenshotPath = `${BROWSER_DIR}/screenshots/${resultId}.png`;
        const result = await withPage(async (page) => {
          await page.goto(task.url!, { waitUntil: "domcontentloaded", timeout: task.timeout ?? 30000 });
          if (task.waitFor) await page.waitForSelector(task.waitFor, { timeout: 10000 });
          await page.screenshot({ path: screenshotPath, fullPage: false });
          return { title: await page.title(), url: page.url() };
        }, task.timeout);

        return {
          id: resultId, taskId: task.id, success: true, type: task.type,
          url: result.url, title: result.title, screenshotPath,
          durationMs: Date.now() - start, completedAt: Date.now(),
        };
      }

      case "extract": {
        if (!task.url) throw new Error("url is required for extract");
        if (!task.selector) throw new Error("selector is required for extract");
        const result = await withPage(async (page) => {
          await page.goto(task.url!, { waitUntil: "domcontentloaded", timeout: task.timeout ?? 30000 });
          const elements = await page.$$(task.selector!);
          const texts: string[] = [];
          for (const el of elements) {
            const text = await el.innerText().catch(() => "");
            if (text.trim()) texts.push(text.trim());
          }
          return { title: await page.title(), url: page.url(), content: texts.join("\n---\n").slice(0, 10000) };
        }, task.timeout);

        return {
          id: resultId, taskId: task.id, success: true, type: task.type,
          url: result.url, title: result.title, content: result.content,
          durationMs: Date.now() - start, completedAt: Date.now(),
        };
      }

      case "fill": {
        if (!task.url) throw new Error("url is required for fill");
        if (!task.selector) throw new Error("selector is required for fill");
        if (task.value === undefined) throw new Error("value is required for fill");
        const result = await withPage(async (page) => {
          await page.goto(task.url!, { waitUntil: "domcontentloaded", timeout: task.timeout ?? 30000 });
          await page.fill(task.selector!, task.value!);
          return { title: await page.title(), url: page.url() };
        }, task.timeout);

        return {
          id: resultId, taskId: task.id, success: true, type: task.type,
          url: result.url, title: result.title, content: `Filled "${task.selector}" with value`,
          durationMs: Date.now() - start, completedAt: Date.now(),
        };
      }

      case "click": {
        if (!task.url) throw new Error("url is required for click");
        if (!task.selector) throw new Error("selector is required for click");
        const result = await withPage(async (page) => {
          await page.goto(task.url!, { waitUntil: "domcontentloaded", timeout: task.timeout ?? 30000 });
          await page.click(task.selector!);
          if (task.waitFor) await page.waitForSelector(task.waitFor, { timeout: 10000 });
          const content = await page.evaluate(() => document.body?.innerText?.slice(0, 5000) || "");
          return { title: await page.title(), url: page.url(), content };
        }, task.timeout);

        return {
          id: resultId, taskId: task.id, success: true, type: task.type,
          url: result.url, title: result.title, content: result.content,
          durationMs: Date.now() - start, completedAt: Date.now(),
        };
      }

      case "script": {
        if (!task.url) throw new Error("url is required for script");
        if (!task.script) throw new Error("script is required for script");
        const result = await withPage(async (page) => {
          await page.goto(task.url!, { waitUntil: "domcontentloaded", timeout: task.timeout ?? 30000 });
          const evalResult = await page.evaluate(task.script!);
          const content = typeof evalResult === "string" ? evalResult : JSON.stringify(evalResult, null, 2);
          return { title: await page.title(), url: page.url(), content: (content || "").slice(0, 10000) };
        }, task.timeout);

        return {
          id: resultId, taskId: task.id, success: true, type: task.type,
          url: result.url, title: result.title, content: result.content,
          durationMs: Date.now() - start, completedAt: Date.now(),
        };
      }

      default:
        throw new Error(`Unknown task type: ${task.type}`);
    }
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    log(`Task ${task.id} failed: ${errorMsg}`);
    return {
      id: resultId, taskId: task.id, success: false, type: task.type,
      url: task.url, error: errorMsg,
      durationMs: Date.now() - start, completedAt: Date.now(),
    };
  }
}

// ── Multi-step workflow ──

export async function runWorkflow(tasks: BrowserTask[]): Promise<BrowserTaskResult[]> {
  if (!isIntegrationEnabled("browser")) {
    throw new Error("Browser integration is disabled");
  }

  const results: BrowserTaskResult[] = [];
  const history = loadHistory();
  const state = loadState();

  for (const task of tasks) {
    if (!task.id) task.id = randomUUID();
    log(`Executing task ${task.id}: ${task.type} ${task.url || task.selector || ""}`);

    const result = await executeTask(task);
    results.push(result);
    history.push(result);

    state.totalTasks++;
    state.lastTaskAt = Date.now();

    // Stop workflow on failure unless it's just an extract miss
    if (!result.success) {
      log(`Workflow stopped at task ${task.id}: ${result.error}`);
      break;
    }
  }

  state.activeSessions = activeSessions;
  saveState(state);
  saveHistory(history);

  return results;
}

// ── Convenience: single-task shortcuts ──

export async function navigateTo(url: string): Promise<BrowserTaskResult> {
  const results = await runWorkflow([{ id: randomUUID(), type: "navigate", url }]);
  return results[0];
}

export async function takeScreenshot(url: string): Promise<BrowserTaskResult> {
  const results = await runWorkflow([{ id: randomUUID(), type: "screenshot", url }]);
  return results[0];
}

export async function extractText(url: string, selector: string): Promise<BrowserTaskResult> {
  const results = await runWorkflow([{ id: randomUUID(), type: "extract", url, selector }]);
  return results[0];
}

export async function runScript(url: string, script: string): Promise<BrowserTaskResult> {
  const results = await runWorkflow([{ id: randomUUID(), type: "script", url, script }]);
  return results[0];
}

// ── Status & lifecycle ──

export function getBrowserStatus(): BrowserStatus {
  const state = loadState();
  const history = loadHistory();

  return {
    ready: browserInstance?.isConnected() ?? false,
    activeSessions,
    totalTasks: state.totalTasks,
    lastTaskAt: state.lastTaskAt,
    recentTasks: history.slice(-10).reverse(),
  };
}

export function clearBrowserHistory(): void {
  saveHistory([]);
  log("Browser task history cleared");
}

export async function closeBrowser(): Promise<void> {
  if (browserInstance) {
    await browserInstance.close().catch(() => {});
    browserInstance = null;
    const state = loadState();
    state.ready = false;
    state.activeSessions = 0;
    saveState(state);
    log("Browser closed");
  }
}

export async function initBrowser(): Promise<void> {
  if (!isIntegrationEnabled("browser")) {
    log("Browser integration disabled, skipping init");
    return;
  }
  ensureDir();
  log("Browser integration initialized (lazy launch — browser starts on first task)");
}
