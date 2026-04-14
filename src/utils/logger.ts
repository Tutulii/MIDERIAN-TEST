export type LogLevel = "debug" | "info" | "warn" | "error";

interface LogContext {
  ticket_id?: string;
  deal_id?: string;
  agent_id?: string;
  [key: string]: any;
}

class StructuredLogger {
  private baseContext: LogContext = {};
  
  public withContext(context: LogContext): StructuredLogger {
    const scopedLogger = new StructuredLogger();
    scopedLogger.baseContext = { ...this.baseContext, ...context };
    return scopedLogger;
  }

  private safeStringify(obj: any): string {
    const cache = new Set();
    return JSON.stringify(obj, (key, value) => {
      // Handle BigInts
      if (typeof value === "bigint") return value.toString();
      // Avoid circular references safely
      if (typeof value === "object" && value !== null) {
        if (cache.has(value)) return "[Circular]";
        cache.add(value);
      }
      return value;
    });
  }

  private emit(level: LogLevel, event: string, context?: LogContext, error?: unknown): void {
    const payload: any = {
      level,
      event,
      timestamp: Date.now(),
      service: "middleman-agent",
    };

    // Merge explicitly mapped contextual params preventing pollution
    const mergedContext = { ...this.baseContext, ...context };
    
    // Bubble up first-class metrics correctly
    if (mergedContext.ticket_id) {
      payload.ticket_id = mergedContext.ticket_id;
      delete mergedContext.ticket_id;
    }
    if (mergedContext.deal_id) {
      payload.deal_id = mergedContext.deal_id;
      delete mergedContext.deal_id;
    }
    if (mergedContext.agent_id) {
      payload.agent_id = mergedContext.agent_id;
      delete mergedContext.agent_id;
    }
    
    // Expose remaining generic context objects mapping internal steps exclusively
    if (Object.keys(mergedContext).length > 0) {
      payload.context = mergedContext;
    }

    if (error) {
      if (error instanceof Error) {
        payload.context = payload.context || {};
        payload.context.error_message = error.message;
        if (level === "error") {
            payload.context.error_stack = error.stack;
        }
      } else {
        payload.context = payload.context || {};
        payload.context.error_message = String(error);
      }
    }

    const output = this.safeStringify(payload);

    // Stdout mapping strictly
    switch (level) {
      case "debug": console.debug(output); break;
      case "info":  console.log(output); break;
      case "warn":  console.warn(output); break;
      case "error": console.error(output); break;
    }
  }

  public debug(event: string, context?: LogContext): void {
    this.emit("debug", event, context);
  }

  public info(event: string, context?: LogContext): void {
    this.emit("info", event, context);
  }

  public warn(event: string, context?: LogContext, error?: unknown): void {
    this.emit("warn", event, context, error);
  }

  public error(event: string, context?: LogContext, error?: unknown): void {
    this.emit("error", event, context, error);
  }
}

export const logger = new StructuredLogger();
