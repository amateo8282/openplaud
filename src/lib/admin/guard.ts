import { cookies, headers as nextHeaders } from "next/headers";
import { notFound } from "next/navigation";
import { db } from "@/db";
import { adminAuditLog } from "@/db/schema";
import { auth } from "@/lib/auth";
import { env } from "@/lib/env";
import { AppError, ErrorCode } from "@/lib/errors";
import {
    ADMIN_ELEVATED_COOKIE,
    isWithinMutationTtl,
    isWithinReauthTtl,
    verifyElevatedCookie,
} from "./elevated-cookie";
import {
    clientIpFromHeaders,
    ipMatchesAllowlist,
    warnIfIpAllowlistTrustsXff,
} from "./ip-allowlist";

// One-time startup warning if an IP allowlist is configured (gate
// trusts XFF). Idempotent across imports.
if (env.IS_HOSTED && env.ADMIN_IP_ALLOWLIST.length > 0) {
    warnIfIpAllowlistTrustsXff(env.ADMIN_IP_ALLOWLIST);
}

/**
 * Admin gate. Defense in depth -- every step must pass or the request 404s.
 * 404 (not 403) is intentional: we do not confirm the route exists to outside
 * observers.
 *
 * Order of checks:
 *   1. IS_HOSTED == true. Self-host has no /admin at all.
 *   2. ADMIN_EMAILS non-empty. Empty allowlist == feature off.
 *   3. ADMIN_IP_ALLOWLIST match (if configured).
 *   4. Authenticated session.
 *   5. session.user.email in ADMIN_EMAILS.
 *   6. Elevated cookie present, MAC-valid, within reauth TTL.
 *      Failure here returns mode='reauth' so the page-level layout can
 *      redirect to /admin/reauth instead of 404'ing the entire route.
 *   7. (mutation requests only) cookie also within mutation TTL.
 *
 * On success the read access is recorded in admin_audit_log.
 */

export type AdminGuardOk = {
    mode: "ok";
    user: { id: string; email: string };
    elevatedIssuedAt: number;
};

export type AdminGuardReauth = {
    mode: "reauth";
    user: { id: string; email: string };
    /** What page the reauth flow should bounce back to on success. */
    returnTo: string;
};

export type AdminGuardResult = AdminGuardOk | AdminGuardReauth;

interface AssertOptions {
    /** Whether this gate is being called from a mutation handler (stricter TTL). */
    mutation?: boolean;
    /** Route label for audit log (e.g. "/admin/users"). */
    route: string;
    /** Method label for audit log (GET/POST/...). */
    method: string;
    /**
     * If set, where to send the user after successful reauth. Only meaningful
     * for layout/page calls; mutation API calls always 404 on stale cookie.
     */
    returnTo?: string;
}

/**
 * Lower-level admin gate returning a discriminated result. Mutations
 * never receive `'reauth'` and 404 on any failure including stale
 * cookies.
 */
async function evaluateAdminGate(
    opts: AssertOptions,
): Promise<AdminGuardResult | null> {
    // 1. Hosted gate.
    if (!env.IS_HOSTED) return null;

    // 2. Allowlist must be configured.
    if (env.ADMIN_EMAILS.length === 0) return null;

    const hdrs = await nextHeaders();

    // 3. IP allowlist (no-op when empty).
    if (env.ADMIN_IP_ALLOWLIST.length > 0) {
        const ip = clientIpFromHeaders(hdrs);
        if (!ipMatchesAllowlist(ip, env.ADMIN_IP_ALLOWLIST)) return null;
    }

    // 4. Session.
    const session = await auth.api.getSession({ headers: hdrs });
    if (!session?.user) return null;

    // 5. Email in allowlist (case/whitespace-normalized like the env parser).
    const email = session.user.email?.trim().toLowerCase();
    if (!email || !env.ADMIN_EMAILS.includes(email)) return null;

    // 6 + 7. Elevated cookie.
    const cookieStore = await cookies();
    const raw = cookieStore.get(ADMIN_ELEVATED_COOKIE)?.value;
    const payload = verifyElevatedCookie(raw);

    // Cookie missing/tampered/wrong user.
    if (!payload || payload.userId !== session.user.id) {
        if (opts.mutation) return null;
        return {
            mode: "reauth",
            user: { id: session.user.id, email },
            returnTo: opts.returnTo ?? "/admin",
        };
    }

    // Cookie outside reauth window.
    if (!isWithinReauthTtl(payload)) {
        if (opts.mutation) return null;
        return {
            mode: "reauth",
            user: { id: session.user.id, email },
            returnTo: opts.returnTo ?? "/admin",
        };
    }

    // Mutation handlers additionally require the tighter window.
    if (opts.mutation && !isWithinMutationTtl(payload)) return null;

    // Audit the access. Awaited so the row is durable before the
    // request proceeds. Transient DB failure logs and continues so a
    // hiccup on the audit table can't lock the admin out.
    try {
        await db.insert(adminAuditLog).values({
            adminUserId: session.user.id,
            adminUserEmail: email,
            route: opts.route,
            method: opts.method,
            ip: clientIpFromHeaders(hdrs),
            userAgent: hdrs.get("user-agent"),
        });
    } catch (err) {
        console.error("[admin] audit log insert failed", err);
    }

    return {
        mode: "ok",
        user: { id: session.user.id, email },
        elevatedIssuedAt: payload.issuedAt,
    };
}

/**
 * Server-component admin gate. Hard failures 404; soft failures
 * (missing/expired elevated cookie) return `'reauth'` so the caller
 * can redirect to `/admin/reauth?next=...`.
 */
export async function requireAdminPage(
    opts: Omit<AssertOptions, "mutation">,
): Promise<AdminGuardResult> {
    const res = await evaluateAdminGate({ ...opts, mutation: false });
    if (!res) notFound();
    return res;
}

/** Read-API admin gate. 404s on any failure (no redirect). */
export async function requireAdminApi(
    opts: Omit<AssertOptions, "mutation">,
): Promise<AdminGuardOk> {
    const res = await evaluateAdminGate({ ...opts, mutation: false });
    if (!res || res.mode !== "ok") {
        throw new AppError(ErrorCode.NOT_FOUND, "Not found", 404);
    }
    return res;
}

/** Mutation-API admin gate. Stricter TTL. 404s on any failure. */
export async function requireAdminMutation(
    opts: Omit<AssertOptions, "mutation">,
): Promise<AdminGuardOk> {
    const res = await evaluateAdminGate({ ...opts, mutation: true });
    if (!res || res.mode !== "ok") {
        throw new AppError(ErrorCode.NOT_FOUND, "Not found", 404);
    }
    return res;
}

/**
 * Cheap predicate for nav rendering. Does NOT verify the elevated
 * cookie — use for showing the Admin link, never to authorise.
 */
export function isAdminEmail(email: string | null | undefined): boolean {
    if (!env.IS_HOSTED) return false;
    if (env.ADMIN_EMAILS.length === 0) return false;
    if (!email) return false;
    return env.ADMIN_EMAILS.includes(email.trim().toLowerCase());
}
