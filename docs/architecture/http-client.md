# Outbound HTTP for Plaud API calls

This document describes the outbound HTTP layer that OpenPlaud uses
when talking to the Plaud API on behalf of a connected user. It applies
only to Plaud-bound requests; all other outbound traffic (S3, AI
providers, SMTP, webhooks) uses the standard global `fetch`.

The implementation lives in:

- `src/lib/plaud/fetch.ts` — the `plaudFetch` entry point.
- `src/lib/plaud/proxy.ts` — proxy list management and selection.
- `src/lib/plaud/client.ts` — higher-level `PlaudClient` with
  retry/backoff for HTTP-level failures.

## Goals

1. **Reliable delivery from any deployment topology.** OpenPlaud is
   self-hosted by users on a mix of homelab boxes, residential
   connections, and various VPS providers. The HTTP layer should not
   make assumptions about the operator's egress.
2. **Operator-configurable proxying.** When an operator's egress IP is
   not viable for direct Plaud traffic, they can configure a Webshare
   API key and route Plaud calls through the datacenter proxies in
   their Webshare account. Default behaviour without any proxy
   configuration is direct egress.
3. **Per-user fairness.** Retries and proxy rotations must not let one
   user's failing connection starve other concurrent syncs.
4. **No collateral damage.** Only Plaud hostnames go through the proxy
   path. Everything else uses the global `fetch` unchanged.

## Layers

### `plaudFetch(url, init)`

A drop-in `fetch`-shaped wrapper. For each call:

1. `shouldProxyPlaud(url)` decides whether the URL is in scope. URLs
   that are not Plaud hostnames fall through to the global `fetch` with
   no modification.
2. If a Webshare API key is configured, a proxy is selected via
   `getPlaudProxyUrl()`. If none is available, the call also falls
   through to direct `fetch`.
3. The request is sent via the configured HTTP client with the chosen
   proxy URL applied.
4. On a 403/407 response or a connection-level error, the proxy is
   marked bad and one retry is attempted with a fresh proxy. After the
   single retry budget is exhausted the response (or error) is
   returned to the caller as-is.

The rotation budget is intentionally small. Repeated 403s after a
rotation are almost always upstream-side (expired token, missing
workspace context) rather than proxy-side, and burning more rotations
on those does nothing useful.

### `proxy.ts` — Webshare list management

When `WEBSHARE_API_KEY` is set, the module pulls the operator's proxy
list from Webshare's `proxy/list/?mode=direct` endpoint (a fixed list
of stable datacenter IPs the operator has provisioned) and caches it
for five minutes. Each `plaudFetch` call picks one at random from the
currently valid set.

`invalidatePlaudProxy(proxy)` takes the proxy object explicitly so
concurrent callers cannot blacklist each other's choice by race. Each
caller threads its own `SelectedProxy` through `plaudFetch` and
invalidates exactly the one it just used.

When the entire list becomes blacklisted, one forced refresh is
attempted before giving up; subsequent calls within the same window
fall through to direct egress rather than spinning on an empty list.

### `PlaudClient` — application-level retry

`plaudFetch` handles proxy-rotation retries. `PlaudClient.request`
adds a small exponential-backoff retry budget on top of that for:

- HTTP 429 with `Retry-After` (the value is honoured when present;
  otherwise exponential).
- HTTP 5xx responses.
- Network-level `TypeError` from the fetch layer.

After `MAX_RETRIES` attempts, failures are mapped into the
`PLAUD_*` `ErrorCode` family via `plaudHttpError` so the route
boundary can return the correct status to the client.

## Self-host vs hosted defaults

Both runtime modes go through the same code path. The only difference
is which env vars are likely to be set:

- Self-host default: no `WEBSHARE_API_KEY`. All calls go direct.
- Operators on egress IPs where direct calls fail can set
  `WEBSHARE_API_KEY` to route through their own Webshare datacenter
  proxies. `PLAUD_PROXY_SCOPE="api-only"` further restricts proxying
  to API calls (skipping the signed-URL CDN), which saves the bulk of
  the bandwidth budget for operators whose egress can reach
  `resource.plaud.ai` directly.

## What this layer is not

- It is not a generic HTTP client. The proxy and retry behaviour is
  scoped to Plaud hostnames via `shouldProxyPlaud`. Other outbound
  HTTP in the codebase uses the standard `fetch`.
- It is not a security boundary on its own. SSRF defence lives in the
  caller-side URL validators (`safePlaudUrl`, `isValidPlaudApiUrl`)
  which run before `plaudFetch` is invoked.
