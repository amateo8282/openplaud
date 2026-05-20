/**
 * Standardised error envelope returned by every API route:
 *
 *     { "error": "human message", "code": "MACHINE_READABLE", "details"?: {...} }
 *
 * Contract:
 *   - `error`   safe to display; no stack traces, secrets, or upstream payloads.
 *   - `code`    stable SCREAMING_SNAKE_CASE; the enum is a public API contract,
 *               never repurpose a shipped value.
 *   - `details` whitelisted machine-readable extras only; never splat
 *               upstream objects, they may carry secrets.
 *
 * Status codes mirror `AppError.statusCode`. See `docs/error-codes.md`
 * for the full per-code reference.
 */

import { NextResponse } from "next/server";

export enum ErrorCode {
    // Auth ------------------------------------------------------------------
    UNAUTHORIZED = "UNAUTHORIZED",
    FORBIDDEN = "FORBIDDEN",
    ACCOUNT_SUSPENDED = "ACCOUNT_SUSPENDED",
    SESSION_EXPIRED = "SESSION_EXPIRED",
    AUTH_SESSION_MISSING = "AUTH_SESSION_MISSING",
    AUTH_SESSION_EXPIRED = "AUTH_SESSION_EXPIRED",

    // Input -----------------------------------------------------------------
    INVALID_INPUT = "INVALID_INPUT",
    MISSING_REQUIRED_FIELD = "MISSING_REQUIRED_FIELD",
    INVALID_FILE_FORMAT = "INVALID_FILE_FORMAT",

    // Resource --------------------------------------------------------------
    NOT_FOUND = "NOT_FOUND",
    ALREADY_EXISTS = "ALREADY_EXISTS",
    CONFLICT = "CONFLICT",

    // Plaud -----------------------------------------------------------------
    PLAUD_CONNECTION_FAILED = "PLAUD_CONNECTION_FAILED",
    PLAUD_INVALID_TOKEN = "PLAUD_INVALID_TOKEN",
    PLAUD_API_ERROR = "PLAUD_API_ERROR", // 4xx-from-Plaud, user-actionable
    PLAUD_UPSTREAM_ERROR = "PLAUD_UPSTREAM_ERROR", // 5xx-from-Plaud or our infra
    PLAUD_RATE_LIMITED = "PLAUD_RATE_LIMITED",
    PLAUD_OTP_INVALID = "PLAUD_OTP_INVALID",
    PLAUD_OTP_EXPIRED = "PLAUD_OTP_EXPIRED",
    PLAUD_INVALID_API_BASE = "PLAUD_INVALID_API_BASE", // SSRF guard
    PLAUD_REGION_REDIRECT_LOOP = "PLAUD_REGION_REDIRECT_LOOP",
    PLAUD_NOT_CONNECTED = "PLAUD_NOT_CONNECTED",
    PLAUD_WORKSPACE_UNAVAILABLE = "PLAUD_WORKSPACE_UNAVAILABLE",

    // Storage ---------------------------------------------------------------
    STORAGE_ERROR = "STORAGE_ERROR",
    STORAGE_QUOTA_EXCEEDED = "STORAGE_QUOTA_EXCEEDED",
    FILE_TOO_LARGE = "FILE_TOO_LARGE",
    PATH_TRAVERSAL_DETECTED = "PATH_TRAVERSAL_DETECTED",

    // Transcription ---------------------------------------------------------
    TRANSCRIPTION_FAILED = "TRANSCRIPTION_FAILED",
    NO_TRANSCRIPTION_PROVIDER = "NO_TRANSCRIPTION_PROVIDER",
    TRANSCRIPTION_API_ERROR = "TRANSCRIPTION_API_ERROR",

    // AI providers (declared now, used in Phase 3) --------------------------
    AI_PROVIDER_NOT_CONFIGURED = "AI_PROVIDER_NOT_CONFIGURED",
    AI_PROVIDER_API_ERROR = "AI_PROVIDER_API_ERROR",
    AI_RATE_LIMITED = "AI_RATE_LIMITED",

    // Recordings (declared now, used in Phase 3) ----------------------------
    RECORDING_NOT_FOUND = "RECORDING_NOT_FOUND",
    RECORDING_STREAM_INVALID_RANGE = "RECORDING_STREAM_INVALID_RANGE",

    // Notifications ---------------------------------------------------------
    EMAIL_SEND_FAILED = "EMAIL_SEND_FAILED",
    SMTP_NOT_CONFIGURED = "SMTP_NOT_CONFIGURED",
    SMTP_AUTH_FAILED = "SMTP_AUTH_FAILED",
    NOTIFICATION_FAILED = "NOTIFICATION_FAILED",

    // DB --------------------------------------------------------------------
    DATABASE_ERROR = "DATABASE_ERROR",
    UNIQUE_CONSTRAINT_VIOLATION = "UNIQUE_CONSTRAINT_VIOLATION",

    // Generic ---------------------------------------------------------------
    INTERNAL_ERROR = "INTERNAL_ERROR",
    SERVICE_UNAVAILABLE = "SERVICE_UNAVAILABLE",
    RATE_LIMITED = "RATE_LIMITED",
    /**
     * Upstream (Plaud, AI provider, S3, mail relay, ...) returned a
     * response we couldn't parse — typically an HTML body or empty
     * payload where JSON was expected. Surfaced as 502 to distinguish
     * "their problem" from `INTERNAL_ERROR` (our bug).
     */
    UPSTREAM_BAD_RESPONSE = "UPSTREAM_BAD_RESPONSE",
}

export interface AppErrorJSON {
    error: string;
    code: ErrorCode;
    details?: Record<string, unknown>;
}

/**
 * Application error with machine-readable code + intended HTTP status.
 * Always throw `AppError` from helpers reachable by route handlers;
 * plain `Error`s fall through `mapErrorToAppError` to a generic 500.
 */
export class AppError extends Error {
    constructor(
        public code: ErrorCode,
        message: string,
        public statusCode: number = 500,
        public details?: Record<string, unknown>,
    ) {
        super(message);
        this.name = "AppError";
    }

    toJSON(): AppErrorJSON {
        return {
            error: this.message,
            code: this.code,
            ...(this.details && { details: this.details }),
        };
    }
}

/** Legacy helper; new code should use `errorResponse` or `apiHandler`. */
export function createErrorResponse(error: AppError | Error | unknown): {
    body: AppErrorJSON;
    status: number;
} {
    const app = mapErrorToAppError(error);
    return { body: app.toJSON(), status: app.statusCode };
}

/** One-line catch-block helper for routes not wrapped in `apiHandler`. */
export function errorResponse(error: AppError | Error | unknown): NextResponse {
    const app = mapErrorToAppError(error);
    if (app.statusCode >= 500) {
        const errorId = attachErrorId(app);
        console.error(`[api] [${errorId}]`, app.code, error);
    }
    return NextResponse.json(app.toJSON(), { status: app.statusCode });
}

type RouteHandler<Ctx> = (
    request: Request,
    context?: Ctx,
) => Promise<Response> | Response;

/**
 * Wrap a route handler so thrown errors become the unified envelope.
 * Logs `>=500` failures. Unmapped errors map to `INTERNAL_ERROR` with
 * a generic message — raw `Error.message` is never reflected to the
 * client. Domain-specific codes must travel on the thrown `AppError`.
 */
export function apiHandler<Ctx = unknown>(
    handler: RouteHandler<Ctx>,
): RouteHandler<Ctx> {
    return async (request, context) => {
        try {
            return await handler(request, context);
        } catch (error) {
            const app = mapErrorToAppError(error);
            if (app.statusCode >= 500) {
                const errorId = attachErrorId(app);
                console.error(`[api] [${errorId}]`, app.code, error);
            }
            return NextResponse.json(app.toJSON(), { status: app.statusCode });
        }
    };
}

/**
 * Stamp a short correlation id (`err_` + 8 hex) onto `app.details` and
 * return it. Idempotent: re-runs preserve the existing id so the
 * envelope and the log line stay in sync.
 */
function attachErrorId(app: AppError): string {
    const existing = app.details?.errorId;
    if (typeof existing === "string" && existing.startsWith("err_")) {
        return existing;
    }
    const errorId = `err_${crypto.randomUUID().replace(/-/g, "").slice(0, 8)}`;
    app.details = { ...(app.details ?? {}), errorId };
    return errorId;
}

/**
 * Map an arbitrary thrown value into an `AppError`. `AppError` passes
 * through verbatim; known string patterns from third-party libs map to
 * domain codes; everything else falls through to `INTERNAL_ERROR` with
 * a generic message (raw `Error.message` is never reflected).
 */
export function mapErrorToAppError(error: unknown): AppError {
    if (error instanceof AppError) {
        return error;
    }

    if (error instanceof Error) {
        // Raw `SyntaxError`s from JSON parsing are NOT auto-mapped:
        // upstream-body and client-body parse failures share the same
        // exception shape, so a blanket mapping mis-classifies one.
        // Callers wrap parsing themselves and throw typed `AppError`s.

        if (error.message.includes("path traversal")) {
            return new AppError(
                ErrorCode.PATH_TRAVERSAL_DETECTED,
                "Invalid file path detected",
                400,
            );
        }

        // Postgres SQLSTATE 23505 = unique_violation. Prefer the typed
        // `code`/`cause.code`; substring match is a fallback for wrappers.
        const pgCode = (error as { code?: unknown; cause?: { code?: unknown } })
            .code;
        const causeCode = (error as { cause?: { code?: unknown } }).cause?.code;
        if (
            pgCode === "23505" ||
            causeCode === "23505" ||
            error.message.includes("unique") ||
            error.message.includes("duplicate")
        ) {
            return new AppError(
                ErrorCode.UNIQUE_CONSTRAINT_VIOLATION,
                "This resource already exists",
                409,
            );
        }

        // Legacy `Plaud API error (NNN): ...` strings. Safety net for
        // any un-migrated callsite; current helpers throw `AppError`.
        if (error.message.includes("Plaud API error")) {
            const match = /^Plaud API error \((\d{3})\):/.exec(error.message);
            if (match) {
                const status = Number.parseInt(match[1], 10);
                if (status === 429) {
                    return new AppError(
                        ErrorCode.PLAUD_RATE_LIMITED,
                        "Too many requests to Plaud. Please try again later.",
                        429,
                    );
                }
                if (status >= 500) {
                    return new AppError(
                        ErrorCode.PLAUD_UPSTREAM_ERROR,
                        "Plaud is temporarily unavailable. Please try again later.",
                        502,
                    );
                }
                return new AppError(
                    ErrorCode.PLAUD_API_ERROR,
                    error.message.replace(/^Plaud API error \(\d{3}\):\s*/, ""),
                    400,
                    { plaudStatus: status },
                );
            }
            // Bare `Plaud API error: ...` (business-level, HTTP 200).
            return new AppError(
                ErrorCode.PLAUD_API_ERROR,
                error.message.replace(/^Plaud API error:\s*/, ""),
                400,
            );
        }

        if (error.message.includes("SMTP")) {
            if (error.message.includes("authentication")) {
                return new AppError(
                    ErrorCode.SMTP_AUTH_FAILED,
                    "Email authentication failed. Please check your SMTP credentials.",
                    500,
                );
            }
            if (error.message.includes("not configured")) {
                return new AppError(
                    ErrorCode.SMTP_NOT_CONFIGURED,
                    "Email service is not configured",
                    500,
                );
            }
            return new AppError(
                ErrorCode.EMAIL_SEND_FAILED,
                "Failed to send email notification. Please check your email settings.",
                500,
            );
        }

        if (error.message.includes("storage")) {
            return new AppError(
                ErrorCode.STORAGE_ERROR,
                "Failed to access storage. Please contact support if this persists.",
                500,
            );
        }

        if (error.message.includes("transcription")) {
            return new AppError(
                ErrorCode.TRANSCRIPTION_FAILED,
                "Failed to transcribe recording. Please try again or check your API configuration.",
                500,
            );
        }
    }

    // Unmapped: generic public message, never leak raw `Error.message`.
    return new AppError(
        ErrorCode.INTERNAL_ERROR,
        "An unexpected error occurred",
        500,
    );
}
