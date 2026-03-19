import { IncomingMessage, ServerResponse } from "http";
import { readBody } from "../web/auth.js";

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
