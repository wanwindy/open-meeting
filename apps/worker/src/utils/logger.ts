export type LogLevel = "debug" | "info" | "warn" | "error";

export interface LoggerContext {
  scope: string;
  sessionId?: string;
  traceId?: string;
}

export class Logger {
  constructor(private readonly context: LoggerContext) {}

  child(extra: Partial<LoggerContext>): Logger {
    return new Logger({ ...this.context, ...extra });
  }

  debug(message: string, extra?: unknown): void {
    this.log("debug", message, extra);
  }

  info(message: string, extra?: unknown): void {
    this.log("info", message, extra);
  }

  warn(message: string, extra?: unknown): void {
    this.log("warn", message, extra);
  }

  error(message: string, extra?: unknown): void {
    this.log("error", message, extra);
  }

  private log(level: LogLevel, message: string, extra?: unknown): void {
    const extraPayload = isRecord(extra) ? extra : extra === undefined ? {} : { data: extra };
    const payload = {
      ts: new Date().toISOString(),
      level,
      scope: this.context.scope,
      sessionId: this.context.sessionId,
      traceId: this.context.traceId,
      message,
      ...extraPayload
    };

    console.log(JSON.stringify(payload));
  }
}

export const rootLogger = new Logger({ scope: "worker" });

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
