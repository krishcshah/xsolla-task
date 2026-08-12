import type { NextFunction, Request, Response } from "express";
import { ApiError } from "../errors.js";

/** Timing-safe-ish bearer check on every /v1/* route (all methods). */
export function makeAuthMiddleware(apiToken: string) {
  return function auth(req: Request, _res: Response, next: NextFunction): void {
    const configured = apiToken;
    // Fail closed when no token is configured.
    const header = req.get("Authorization") ?? "";
    const m = /^Bearer (.+)$/.exec(header.trim());
    if (!configured || !m || !safeEqual(m[1], configured)) {
      next(ApiError.unauthorized());
      return;
    }
    next();
  };
}

function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ba.length !== bb.length) return false;
  let diff = 0;
  for (let i = 0; i < ba.length; i++) diff |= ba[i] ^ bb[i];
  return diff === 0;
}
