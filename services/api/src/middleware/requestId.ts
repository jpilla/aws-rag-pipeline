import { Request, Response, NextFunction } from "express";
import { v4 as uuidv4 } from "uuid";
import { logger } from "../lib/logger";

// Extend Express Request interface to include requestId and child logger
declare global {
  namespace Express {
    interface Request {
      requestId: string;
      logger: any; // pino child logger
    }
  }
}

/**
 * Middleware to generate and assign a Request-Id header
 * Creates a child logger with request-id context for automatic inclusion in all logs
 */
export function requestIdMiddleware(req: Request, res: Response, next: NextFunction) {
  // Generate a new request ID or use existing one from headers
  const requestId = req.headers['request-id'] as string || uuidv4();

  // Attach to request object for use in route handlers
  req.requestId = requestId;

  // Create a child logger with request-id context
  req.logger = logger.child({ requestId });

  // Set the Request-Id header on the response
  res.set('Request-Id', requestId);

  next();
}
