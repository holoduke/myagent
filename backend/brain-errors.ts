/**
 * Structured error hierarchy for the brain tick system.
 * These errors carry context so the circuit breaker and logs
 * can make smarter recovery decisions instead of just counting failures.
 */

export interface BrainErrorContext {
  /** Which tick phase produced the error */
  phase: "think" | "consolidate" | "reflect" | "scheduler" | "observer" | "memory";
  /** Milliseconds the operation ran before failing */
  elapsedMs?: number;
  /** Whether the error is likely transient (e.g. timeout, API error) vs permanent */
  transient: boolean;
  /** Additional structured metadata */
  metadata?: Record<string, unknown>;
}

export class BrainError extends Error {
  public readonly context: BrainErrorContext;

  constructor(message: string, context: BrainErrorContext, cause?: unknown) {
    super(message);
    this.name = "BrainError";
    this.context = context;
    if (cause !== undefined) {
      this.cause = cause;
    }
  }

  /** Format for structured logging */
  toStructuredLog(): Record<string, unknown> {
    return {
      error: this.name,
      message: this.message,
      phase: this.context.phase,
      transient: this.context.transient,
      elapsedMs: this.context.elapsedMs,
      metadata: this.context.metadata,
      cause: this.cause instanceof Error ? this.cause.message : String(this.cause ?? ""),
    };
  }
}

export class TickError extends BrainError {
  constructor(
    tickType: "think" | "consolidate" | "reflect",
    message: string,
    options?: { elapsedMs?: number; transient?: boolean; cause?: unknown; metadata?: Record<string, unknown> },
  ) {
    super(message, {
      phase: tickType,
      elapsedMs: options?.elapsedMs,
      transient: options?.transient ?? true,
      metadata: options?.metadata,
    }, options?.cause);
    this.name = "TickError";
  }
}

export class MemoryError extends BrainError {
  constructor(
    message: string,
    options?: { transient?: boolean; cause?: unknown; metadata?: Record<string, unknown> },
  ) {
    super(message, {
      phase: "memory",
      transient: options?.transient ?? false,
      metadata: options?.metadata,
    }, options?.cause);
    this.name = "MemoryError";
  }
}

export class ProviderError extends BrainError {
  constructor(
    message: string,
    options?: { elapsedMs?: number; cause?: unknown; metadata?: Record<string, unknown> },
  ) {
    super(message, {
      phase: "think",
      elapsedMs: options?.elapsedMs,
      transient: true, // API errors are typically transient
      metadata: options?.metadata,
    }, options?.cause);
    this.name = "ProviderError";
  }
}

export class SchedulerError extends BrainError {
  constructor(
    message: string,
    options?: { transient?: boolean; cause?: unknown; metadata?: Record<string, unknown> },
  ) {
    super(message, {
      phase: "scheduler",
      transient: options?.transient ?? true,
      metadata: options?.metadata,
    }, options?.cause);
    this.name = "SchedulerError";
  }
}

/** Wrap an unknown caught value into a BrainError subclass, preserving context */
export function wrapError(
  err: unknown,
  phase: BrainErrorContext["phase"],
  message: string,
  options?: { elapsedMs?: number; transient?: boolean; metadata?: Record<string, unknown> },
): BrainError {
  if (err instanceof BrainError) return err;

  const isTimeout = err instanceof Error && err.message.includes("timed out");

  switch (phase) {
    case "think":
    case "consolidate":
    case "reflect":
      return new TickError(phase, message, {
        cause: err,
        elapsedMs: options?.elapsedMs,
        transient: options?.transient ?? isTimeout,
        metadata: options?.metadata,
      });
    case "scheduler":
      return new SchedulerError(message, {
        cause: err,
        transient: options?.transient ?? true,
        metadata: options?.metadata,
      });
    case "memory":
      return new MemoryError(message, {
        cause: err,
        transient: options?.transient ?? false,
        metadata: options?.metadata,
      });
    default:
      return new BrainError(message, {
        phase,
        transient: options?.transient ?? true,
        elapsedMs: options?.elapsedMs,
        metadata: options?.metadata,
      }, err);
  }
}
