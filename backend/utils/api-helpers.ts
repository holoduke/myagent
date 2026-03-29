import { IncomingMessage, ServerResponse } from "http";
import { readBody } from "../web/auth.js";

// ── Simple per-IP rate limiter ──

const requestCounts = new Map<string, { count: number; resetAt: number }>();
const RATE_LIMIT_WINDOW = 60_000; // 1 minute
const RATE_LIMIT_MAX = 120; // 120 requests per minute per IP

export function isRateLimited(req: IncomingMessage): boolean {
  const ip = req.socket.remoteAddress || "unknown";
  const now = Date.now();
  const entry = requestCounts.get(ip);

  if (!entry || now > entry.resetAt) {
    requestCounts.set(ip, { count: 1, resetAt: now + RATE_LIMIT_WINDOW });
    return false;
  }

  entry.count++;
  if (entry.count > RATE_LIMIT_MAX) return true;
  return false;
}

// Cleanup stale entries every 5 minutes
setInterval(() => {
  const now = Date.now();
  for (const [ip, entry] of requestCounts) {
    if (now > entry.resetAt) requestCounts.delete(ip);
  }
}, 300_000);

/**
 * Send a JSON response with the given status code and data.
 */
export function respondJson(res: ServerResponse, status: number, data: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
}

/**
 * Read the request body and parse it as JSON.
 */
export async function readJsonBody<T = Record<string, unknown>>(req: IncomingMessage): Promise<T> {
  const raw = await readBody(req);
  return JSON.parse(raw) as T;
}

/**
 * Error subclass that carries an HTTP status code.
 */
export class ApiError extends Error {
  constructor(public statusCode: number, message: string) {
    super(message);
    this.name = "ApiError";
  }
}

/**
 * Wraps a handler that receives (req, res, body) for POST/PUT/PATCH/DELETE requests.
 * Automatically:
 *  - Reads and parses the JSON body
 *  - Wraps in try/catch
 *  - Sends the returned value as a JSON 200 response (or custom status via ApiError)
 *  - Catches errors and returns JSON 400/500
 *
 * If the handler returns `undefined` (void), it is assumed the handler
 * already wrote the response itself (for cases needing custom status codes
 * or early returns).
 */
export function apiHandler<T = unknown>(
  handler: (req: IncomingMessage, res: ServerResponse, body: T) => Promise<unknown | void>,
): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    try {
      const body = await readJsonBody<T>(req);
      const result = await handler(req, res, body);
      if (result !== undefined && !res.headersSent) {
        respondJson(res, 200, result);
      }
    } catch (err) {
      if (res.headersSent) return;
      if (err instanceof ApiError) {
        respondJson(res, err.statusCode, { error: err.message });
      } else {
        respondJson(res, 400, { error: err instanceof Error ? err.message : "Invalid request" });
      }
    }
  };
}

/**
 * Wraps a GET handler that takes (req, res) and returns data.
 * No body parsing. Wraps in try/catch with JSON responses.
 *
 * If the handler returns `undefined`, it is assumed the handler wrote its own response.
 */
export function apiGetHandler(
  handler: (req: IncomingMessage, res: ServerResponse) => Promise<unknown | void> | unknown | void,
): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    try {
      const result = await handler(req, res);
      if (result !== undefined && !res.headersSent) {
        respondJson(res, 200, result);
      }
    } catch (err) {
      if (res.headersSent) return;
      if (err instanceof ApiError) {
        respondJson(res, err.statusCode, { error: err.message });
      } else {
        respondJson(res, 500, { error: err instanceof Error ? err.message : String(err) });
      }
    }
  };
}
