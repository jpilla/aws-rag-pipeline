import { Request, Response, NextFunction } from "express";
import { v4 as uuidv4 } from "uuid";
import { runWithRequestContext } from "../lib/logger";

// Extend Express Request interface to include requestId
declare global {
  namespace Express {
    interface Request {
      requestId: string;
    }
  }
}

/**
 * Middleware to generate and assign a Request-Id header
 * Sets up request context for automatic logging throughout the request lifecycle
 */
export function requestIdMiddleware(req: Request, res: Response, next: NextFunction) {
  // Generate a new request ID or use existing one from headers
  const requestId = req.headers['request-id'] as string || uuidv4();

  // Attach to request object for use in route handlers
  req.requestId = requestId;

  // Set the Request-Id header on the response
  res.set('Request-Id', requestId);

  // Run the rest of the request with request context
  runWithRequestContext(requestId, () => {
    next();
  });
}
