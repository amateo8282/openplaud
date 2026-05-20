import { NextResponse } from "next/server";
import { env } from "@/lib/env";

// Runtime proxy for Rybbit's same-origin endpoints.
//
// Folder name MUST be `src/app/api/int/`, not `_int/`: App Router
// treats `_`-prefixed folders as private and drops them from the route
// manifest (silent 404s in production).
//
// Hosted-only; self-host always 404s. Headers are built from scratch
// rather than copied from the request — cookies and `Authorization`
// must never reach the analytics backend, and rebuilding ensures any
// future header the middleware misses still can't leak through.
// Only XFF / X-Real-IP and User-Agent are forwarded (Rybbit derives
// geolocation from XFF).

function gated(): { ok: false; res: NextResponse } | { ok: true } {
    if (!env.IS_HOSTED || !env.RYBBIT_HOST || !env.RYBBIT_SITE_ID) {
        return {
            ok: false,
            res: new NextResponse("Not found", { status: 404 }),
        };
    }
    return { ok: true };
}

function upstreamUrl(path: string): string {
    // `RYBBIT_HOST` is non-empty by virtue of `gated()`.
    const host = (env.RYBBIT_HOST as string).replace(/\/$/, "");
    const suffix = path.startsWith("/") ? path : `/${path}`;
    return `${host}${suffix}`;
}

function forwardClientHeaders(req: Request, headers: Headers): void {
    const ua = req.headers.get("user-agent");
    if (ua) headers.set("User-Agent", ua);

    // Rebuild XFF from the inbound header so the upstream sees the
    // real client IP rather than the app's egress.
    const xff = req.headers.get("x-forwarded-for");
    if (xff) {
        headers.set("X-Forwarded-For", xff);
    } else {
        const realIp = req.headers.get("x-real-ip");
        if (realIp) headers.set("X-Forwarded-For", realIp);
    }
}

export interface ProxyRybbitGetOptions {
    /** Cache-Control sent to the browser. Defaults to `no-store`. */
    cacheControl?: string;
    /** Fallback `Content-Type` if upstream omits one. */
    fallbackContentType?: string;
}

export async function proxyRybbitGet(
    req: Request,
    upstreamPath: string,
    opts: ProxyRybbitGetOptions = {},
): Promise<NextResponse> {
    const gate = gated();
    if (!gate.ok) return gate.res;

    const headers = new Headers();
    forwardClientHeaders(req, headers);

    let upstreamRes: Response;
    try {
        upstreamRes = await fetch(upstreamUrl(upstreamPath), {
            method: "GET",
            headers,
            cache: "no-store",
        });
    } catch {
        return new NextResponse("Bad gateway", { status: 502 });
    }
    if (!upstreamRes.ok || !upstreamRes.body) {
        return new NextResponse("Bad gateway", { status: 502 });
    }

    const resHeaders = new Headers();
    resHeaders.set(
        "Content-Type",
        upstreamRes.headers.get("content-type") ??
            opts.fallbackContentType ??
            "application/octet-stream",
    );
    resHeaders.set("Cache-Control", opts.cacheControl ?? "no-store");

    return new NextResponse(upstreamRes.body, {
        status: upstreamRes.status,
        headers: resHeaders,
    });
}

export async function proxyRybbitPost(
    req: Request,
    upstreamPath: string,
): Promise<NextResponse> {
    const gate = gated();
    if (!gate.ok) return gate.res;

    const body = await req.arrayBuffer();

    const headers = new Headers();
    headers.set(
        "Content-Type",
        req.headers.get("content-type") ?? "application/json",
    );
    forwardClientHeaders(req, headers);

    let upstreamRes: Response;
    try {
        upstreamRes = await fetch(upstreamUrl(upstreamPath), {
            method: "POST",
            headers,
            body,
            cache: "no-store",
        });
    } catch {
        return new NextResponse("Bad gateway", { status: 502 });
    }

    const resHeaders = new Headers();
    const ct = upstreamRes.headers.get("content-type");
    if (ct) resHeaders.set("Content-Type", ct);

    return new NextResponse(upstreamRes.body, {
        status: upstreamRes.status,
        headers: resHeaders,
    });
}
