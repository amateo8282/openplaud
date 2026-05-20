import { AppError, ErrorCode } from "@/lib/errors";

const BODY_SNIPPET_MAX = 200;

/**
 * Parse a Plaud API `Response` as JSON, or throw a structured `AppError`
 * keyed off `res.status` if the body is not valid JSON / cannot be read.
 *
 * Does not check `res.ok` — callers may legitimately want to parse a 2xx
 * body that carries a business-level `status` field (e.g. the `-302`
 * regional redirect). Status branching below only fires when the body
 * itself is unparseable.
 *
 * On parse failure, `details.bodySnippet` carries the first 200 chars of
 * the response body for log diagnostics.
 */
export async function safeParseJson<T = unknown>(res: Response): Promise<T> {
    // Prefer `.text()` so we can snippet the body on parse failure.
    // The `typeof` guard tolerates test mocks that only stub `.json()`.
    let text = "";
    let parsed: unknown;
    let didParse = false;
    let bodyReadFailed = false;
    if (typeof res.text === "function") {
        try {
            text = await res.text();
        } catch {
            // `.text()` can throw on aborted / dropped connections.
            // Treat as upstream-unavailable rather than letting the raw
            // TypeError escape to `INTERNAL_ERROR`.
            bodyReadFailed = true;
        }
        if (!bodyReadFailed && text.length > 0) {
            try {
                parsed = JSON.parse(text) as T;
                didParse = true;
            } catch {
                // fall through to the structured error below
            }
        }
    } else {
        try {
            parsed = await (res.json() as Promise<T>);
            didParse = true;
        } catch {
            // fall through to the structured error below
        }
    }
    if (didParse) {
        return parsed as T;
    }

    if (bodyReadFailed) {
        throw new AppError(
            ErrorCode.PLAUD_UPSTREAM_ERROR,
            "Plaud closed the connection before sending a response. Please try again later.",
            502,
            { plaudStatus: res.status },
        );
    }

    // Mirrors the mapping in `client.ts:plaudHttpError` so callers see
    // consistent codes whether the failure was HTTP-level or a JSON
    // parse failure.
    const status = res.status;
    let code: ErrorCode;
    let message: string;
    let statusCode: number;
    if (status === 401) {
        code = ErrorCode.PLAUD_INVALID_TOKEN;
        message =
            "Plaud rejected the access token. Reconnect your Plaud account.";
        statusCode = 401;
    } else if (status === 429) {
        code = ErrorCode.PLAUD_RATE_LIMITED;
        message = "Too many requests to Plaud. Please try again later.";
        statusCode = 429;
    } else if (status >= 500) {
        code = ErrorCode.PLAUD_UPSTREAM_ERROR;
        message = "Plaud is temporarily unavailable. Please try again later.";
        statusCode = 502;
    } else if (status >= 400) {
        code = ErrorCode.PLAUD_API_ERROR;
        message = `Plaud returned an unreadable response (HTTP ${status}).`;
        statusCode = 400;
    } else {
        // 2xx/3xx with a non-JSON body — classify as upstream-bad-response.
        code = ErrorCode.PLAUD_UPSTREAM_ERROR;
        message = `Plaud returned an unreadable response (HTTP ${status}).`;
        statusCode = 502;
    }

    throw new AppError(code, message, statusCode, {
        plaudStatus: status,
        bodySnippet: text.slice(0, BODY_SNIPPET_MAX),
    });
}
