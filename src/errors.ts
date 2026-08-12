export type ErrorCode =
  | "unauthorized"
  | "payload_too_large"
  | "invalid_json"
  | "invalid_diff"
  | "idempotency_conflict"
  | "not_found"
  | "rate_limited"
  | "internal";

/**
 * Operational error mapped to an HTTP status + machine code in the
 * error envelope { error: { code, message } }.
 */
export class ApiError extends Error {
  readonly status: number;
  readonly code: ErrorCode;
  /** Extra response headers (e.g. Retry-After for 429). */
  readonly headers: Record<string, string>;

  constructor(status: number, code: ErrorCode, message: string, headers: Record<string, string> = {}) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.headers = headers;
  }

  static unauthorized(message = "Missing or invalid bearer token"): ApiError {
    return new ApiError(401, "unauthorized", message, { "WWW-Authenticate": "Bearer" });
  }
  static payloadTooLarge(limit: number): ApiError {
    return new ApiError(413, "payload_too_large", `Payload exceeds the ${limit}-byte limit`);
  }
  static invalidJson(message = "Request body is not valid JSON"): ApiError {
    return new ApiError(400, "invalid_json", message);
  }
  static invalidDiff(message = "diff is missing, empty, or not a parseable unified diff"): ApiError {
    return new ApiError(422, "invalid_diff", message);
  }
  static idempotencyConflict(message = "Idempotency-Key was already used with a different request body"): ApiError {
    return new ApiError(409, "idempotency_conflict", message);
  }
  static notFound(message = "Job not found"): ApiError {
    return new ApiError(404, "not_found", message);
  }
  static rateLimited(retryAfterSeconds: number): ApiError {
    return new ApiError(429, "rate_limited", "Rate limit exceeded; retry later", {
      "Retry-After": String(retryAfterSeconds)
    });
  }
  static internal(message = "Internal error"): ApiError {
    return new ApiError(500, "internal", message);
  }
}
