/**
 * Outbound proxy selection for Plaud API calls. See
 * `docs/architecture/http-client.md` for the overall design.
 */

import { env } from "@/lib/env";

interface WebshareProxy {
    id: string;
    username: string;
    password: string;
    proxy_address: string;
    port: number;
    valid: boolean;
}

interface ProxyCache {
    proxies: WebshareProxy[];
    expiresAt: number;
}

const CACHE_TTL_MS = 5 * 60_000;
const WEBSHARE_LIST_URL =
    "https://proxy.webshare.io/api/v2/proxy/list/?mode=direct&page=1&page_size=100";

let cachedList: ProxyCache | null = null;
let badProxyIds = new Set<string>();

async function fetchProxyList(): Promise<WebshareProxy[]> {
    const apiKey = env.WEBSHARE_API_KEY;
    if (!apiKey) return [];

    try {
        const res = await fetch(WEBSHARE_LIST_URL, {
            headers: { Authorization: `Token ${apiKey}` },
        });
        if (!res.ok) {
            console.warn(
                `[plaud/proxy] Webshare list error: ${res.status} ${res.statusText}`,
            );
            return [];
        }
        const data = (await res.json()) as { results?: WebshareProxy[] };
        const proxies = (data.results ?? []).filter((p) => p.valid);
        cachedList = { proxies, expiresAt: Date.now() + CACHE_TTL_MS };
        badProxyIds = new Set();
        return proxies;
    } catch (err) {
        console.warn(
            "[plaud/proxy] Webshare list fetch failed:",
            err instanceof Error ? err.message : err,
        );
        return [];
    }
}

/**
 * Whether `url` is in the Plaud-proxy scope. Matches plaud.ai and its
 * subdomains, and respects `PLAUD_PROXY_SCOPE="api-only"` (which exempts
 * the signed-URL CDN at resource.plaud.ai). Unknown/malformed URLs are
 * always rejected so non-Plaud traffic is never routed through the proxy.
 */
export function shouldProxyPlaud(url: string): boolean {
    try {
        const u = new URL(url);
        if (u.protocol !== "https:") return false;
        const h = u.hostname.toLowerCase();
        const isPlaud = h === "plaud.ai" || h.endsWith(".plaud.ai");
        if (!isPlaud) return false;
        if (env.PLAUD_PROXY_SCOPE === "api-only" && h === "resource.plaud.ai") {
            return false;
        }
        return true;
    } catch {
        return false;
    }
}

export interface SelectedProxy {
    /** Webshare proxy id — stable handle used for blacklisting. */
    id: string;
    /** http://user:pass@host:port form. Contains credentials — do not log. */
    url: string;
    /** host:port — safe to log. */
    label: string;
}

/**
 * Pick a proxy from the cached Webshare list, lazily refreshing on
 * expiry or when every cached entry has been blacklisted. Returns null
 * when Webshare is unconfigured or has no valid proxies — callers fall
 * back to direct egress.
 */
export async function getPlaudProxyUrl(): Promise<SelectedProxy | null> {
    if (!env.WEBSHARE_API_KEY) return null;

    let proxies: WebshareProxy[];
    let justRefreshed = false;
    if (cachedList && cachedList.expiresAt > Date.now()) {
        proxies = cachedList.proxies;
    } else {
        proxies = await fetchProxyList();
        justRefreshed = true;
    }

    let available = proxies.filter((p) => !badProxyIds.has(p.id));
    if (available.length === 0 && !justRefreshed) {
        // All blacklisted — force one refresh. Guarded by `justRefreshed`
        // so an upstream outage doesn't burn two list requests per call.
        proxies = await fetchProxyList();
        available = proxies;
    }
    if (available.length === 0) {
        console.warn("[plaud/proxy] no valid Webshare proxies available");
        return null;
    }

    const proxy = available[Math.floor(Math.random() * available.length)];
    const url = `http://${encodeURIComponent(proxy.username)}:${encodeURIComponent(proxy.password)}@${proxy.proxy_address}:${proxy.port}`;
    const label = `${proxy.proxy_address}:${proxy.port}`;
    return { id: proxy.id, url, label };
}

/**
 * Mark `proxy` as bad. Takes the proxy explicitly (rather than reading a
 * "last served" module global) so concurrent `plaudFetch` calls cannot
 * blacklist each other's proxy by race — each caller invalidates exactly
 * the `SelectedProxy` it just used.
 */
export function invalidatePlaudProxy(proxy: SelectedProxy): void {
    badProxyIds.add(proxy.id);
}

export function isPlaudProxyConfigured(): boolean {
    return Boolean(env.WEBSHARE_API_KEY);
}

/** Test-only: reset module state between unit tests. */
export function _resetPlaudProxyCacheForTest(): void {
    cachedList = null;
    badProxyIds = new Set();
}
