import pino from "pino";
import { AsyncLocalStorage } from "async_hooks";

const level = process.env.LOG_LEVEL ?? "info";
const baseLogger = pino({ level, base: undefined, timestamp: pino.stdTimeFunctions.isoTime });

// AsyncLocalStorage to store request context
const requestContext = new AsyncLocalStorage<{ requestId: string; logger: any }>();

// Create a request-scoped logger that automatically includes request ID
export function createRequestLogger(requestId: string) {
  return baseLogger.child({ requestId });
}

// Run a function with request context
export function runWithRequestContext<T>(requestId: string, fn: () => T): T {
  const requestLogger = createRequestLogger(requestId);
  return requestContext.run({ requestId, logger: requestLogger }, fn);
}

// Simple logger that checks context - no Proxy overhead
export const logger = {
  info: (obj?: any, msg?: string) => {
    const context = requestContext.getStore();
    const actualLogger = context?.logger || baseLogger;
    return actualLogger.info(obj, msg);
  },
  error: (obj?: any, msg?: string) => {
    const context = requestContext.getStore();
    const actualLogger = context?.logger || baseLogger;
    return actualLogger.error(obj, msg);
  },
  warn: (obj?: any, msg?: string) => {
    const context = requestContext.getStore();
    const actualLogger = context?.logger || baseLogger;
    return actualLogger.warn(obj, msg);
  },
  debug: (obj?: any, msg?: string) => {
    const context = requestContext.getStore();
    const actualLogger = context?.logger || baseLogger;
    return actualLogger.debug(obj, msg);
  }
};

// Export the base logger for non-request contexts
export { baseLogger as default };
