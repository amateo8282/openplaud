/**
 * Client-side helper for the unified API error envelope:
 *
 *     { error: string, code: ErrorCode, details?: Record<string, unknown> }
 *
 * Callers must switch on `code`, never on the human-readable `error`.
 * See `docs/error-codes.md` for the code reference.
 */

import { toast } from "sonner";
import type { ErrorCode } from "@/lib/errors";
import { buildReportBugUrl } from "@/lib/report-bug";

export interface ApiErrorBody {
    error: string;
    code: ErrorCode | string; // string fallback for older / out-of-band errors
    details?: Record<string, unknown>;
}

/**
 * Parse a non-OK `Response` into the unified envelope. Always returns
 * `{ error, code }`; falls back to a synthetic envelope when an
 * upstream proxy replaces the body with non-JSON.
 */
export async function parseApiError(response: Response): Promise<ApiErrorBody> {
    try {
        const body = (await response.json()) as Partial<ApiErrorBody>;
        if (
            body &&
            typeof body.error === "string" &&
            typeof body.code === "string"
        ) {
            return {
                error: body.error,
                code: body.code,
                ...(body.details && { details: body.details }),
            };
        }
    } catch {
        // fall through
    }
    return {
        error: response.statusText || "Request failed",
        code: "UNKNOWN_ERROR",
    };
}

/** Returns a non-empty error string for toast display. */
export async function getApiErrorMessage(
    response: Response,
    fallback = "Request failed",
): Promise<string> {
    const body = await parseApiError(response);
    return body.error || fallback;
}

export interface ToastApiErrorOptions {
    /** Fallback message if the server omits a human-readable `error`. */
    fallback?: string;
    /** What the user was doing when the error fired (bug-report seed). */
    errorContext?: string;
}

/**
 * Toast a non-OK API response. When the envelope carries an `errorId`
 * (5xx through `apiHandler`), surfaces a one-click "Report" action that
 * opens a pre-filled GitHub issue. Returns the parsed envelope so
 * callers can branch on `code` for recovery flows.
 */
export async function toastApiError(
    response: Response,
    opts: ToastApiErrorOptions = {},
): Promise<ApiErrorBody> {
    const body = await parseApiError(response);
    const message = body.error || opts.fallback || "Request failed";
    const errorId =
        typeof body.details?.errorId === "string"
            ? body.details.errorId
            : undefined;

    if (errorId) {
        const url = buildReportBugUrl({
            errorId,
            errorContext: opts.errorContext,
            page:
                typeof window !== "undefined"
                    ? window.location.pathname
                    : undefined,
        });
        toast.error(message, {
            description: errorId,
            action: {
                label: "Report",
                onClick: () => {
                    window.open(url, "_blank", "noopener,noreferrer");
                },
            },
        });
    } else {
        toast.error(message);
    }

    return body;
}
