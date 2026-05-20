/**
 * `plaudFetch` — `fetch`-shaped wrapper that routes Plaud-bound requests
 * through the operator's configured proxy, with a single rotation on
 * proxy-attributable failures. See `docs/architecture/http-client.md`.
 */

import {
    fetch as impersonateFetch,
    type BodyInit as WreqBodyInit,
} from "wreq-js";
import {
    getPlaudProxyUrl,
    invalidatePlaudProxy,
    type SelectedProxy,
    shouldProxyPlaud,
} from "./proxy";

const MAX_PROXY_ROTATIONS = 1;

const IMPERSONATE_BROWSER = "chrome_142" as const;
const IMPERSONATE_OS = "windows" as const;

export async function plaudFetch(
    url: string,
    init?: RequestInit,
): Promise<Response> {
    if (!shouldProxyPlaud(url)) {
        return fetch(url, init);
    }

    let attempt = 0;
    let currentProxy: SelectedProxy | null = await getPlaudProxyUrl();
    if (!currentProxy) {
        // Webshare unconfigured or list empty → direct fetch.
        return fetch(url, init);
    }

    while (true) {
        let response: Response;
        try {
            response = (await impersonateFetch(url, {
                method: init?.method,
                headers: init?.headers as Record<string, string> | undefined,
                // wreq-js's `BodyInit` is narrower than the DOM's (no
                // ReadableStream). Plaud callers only send JSON-string
                // bodies, so this cast is safe in practice; a streamed
                // body would surface as a type error.
                body: init?.body as WreqBodyInit | null | undefined,
                signal: init?.signal ?? undefined,
                proxy: currentProxy.url,
                browser: IMPERSONATE_BROWSER,
                os: IMPERSONATE_OS,
            })) as unknown as Response;
        } catch (err) {
            if (attempt < MAX_PROXY_ROTATIONS) {
                logProxyEvent(
                    "network-error",
                    url,
                    currentProxy.label,
                    err instanceof Error ? err.message : String(err),
                );
                invalidatePlaudProxy(currentProxy);
                const next = await getPlaudProxyUrl();
                if (!next) {
                    return fetch(url, init);
                }
                currentProxy = next;
                attempt += 1;
                continue;
            }
            throw err;
        }

        if (
            (response.status === 403 || response.status === 407) &&
            attempt < MAX_PROXY_ROTATIONS
        ) {
            logProxyEvent(
                `http-${response.status}`,
                url,
                currentProxy.label,
                response.statusText,
            );
            invalidatePlaudProxy(currentProxy);

            // Resolve the next proxy BEFORE touching the body. If we
            // cancel the body and then discover there is no next proxy,
            // we would return a `Response` whose body has already been
            // consumed and any JSON parse downstream would throw.
            const next = await getPlaudProxyUrl();
            if (!next) return response;

            await response.body?.cancel().catch(() => undefined);
            currentProxy = next;
            attempt += 1;
            continue;
        }

        return response;
    }
}

function logProxyEvent(
    kind: string,
    url: string,
    proxyLabel: string,
    detail: string,
): void {
    let host: string;
    try {
        host = new URL(url).host;
    } catch {
        host = "<invalid-url>";
    }
    console.warn(
        `[plaud/proxy] ${kind} via=${proxyLabel} host=${host} detail=${detail}`,
    );
}

/** Test-only no-op; module holds no fetch-side cache. */
export function _resetPlaudFetchForTest(): void {
    // intentionally empty
}
