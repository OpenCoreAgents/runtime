/**
 * Cross-cutting HTTP concerns: request id, optional bearer auth (host layer), CORS, security headers.
 * The engine’s own policies stay in `AgentRuntime`; this is the BFF edge.
 */
import type { RequestHandler } from "express";
import { randomUUID } from "node:crypto";
import cors from "cors";

/** Propagate or generate `X-Request-Id` for logs and client correlation. */
export const requestId: RequestHandler = (req, res, next) => {
  const id = req.get("x-request-id")?.trim() || randomUUID();
  res.setHeader("X-Request-Id", id);
  (res.locals as { requestId: string }).requestId = id;
  next();
};

export const securityHeaders: RequestHandler = (_req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "no-referrer");
  next();
};

/**
 * If **`API_KEY`** is set in the environment, **`/v1/*`** requires `Authorization: Bearer <API_KEY>`.
 * If unset, the demo stays open (local dev only).
 */
export function optionalBearerAuth(apiKey: string | undefined): RequestHandler {
  if (!apiKey) {
    return (_req, _res, next) => {
      next();
    };
  }
  return (req, res, next) => {
    const auth = req.headers.authorization;
    if (auth !== `Bearer ${apiKey}`) {
      res.status(401).json({
        error: "Unauthorized",
        hint: "Send header: Authorization: Bearer <API_KEY>",
      });
      return;
    }
    next();
  };
}

/** Browser / SPA friendly; tighten `origin` in production (see README). */
export const corsMiddleware = cors({
  origin: true,
  credentials: false,
  methods: ["GET", "POST", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization", "X-Request-Id", "Accept"],
  exposedHeaders: ["X-Request-Id"],
});
