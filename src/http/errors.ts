import type { ContentfulStatusCode } from "hono/utils/http-status";

/** Errors with their own HTTP status and code (auth, media type, configuration, limits, judge mode). */
export class HttpError extends Error {
  override name = "HttpError";
  constructor(
    readonly status: ContentfulStatusCode,
    readonly code: string,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
  }
}
