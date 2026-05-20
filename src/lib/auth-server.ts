import { eq } from "drizzle-orm";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { db } from "@/db";
import { users } from "@/db/schema";
import { auth } from "./auth";
import { AppError, ErrorCode } from "./errors";

/** Server-side session getter (server components / API routes). */
export async function getSession() {
    const session = await auth.api.getSession({
        headers: await headers(),
    });

    return session;
}

/**
 * Require an authenticated, non-suspended session. Redirects to
 * `/login` or `/suspended`. For use in server components.
 */
export async function requireAuth() {
    const session = await getSession();

    if (!session?.user) {
        redirect("/login");
    }

    // Suspension check. PK lookup; on self-host `suspendedAt` is always
    // null (the admin gate is behind IS_HOSTED).
    const [u] = await db
        .select({ suspendedAt: users.suspendedAt })
        .from(users)
        .where(eq(users.id, session.user.id))
        .limit(1);
    if (u?.suspendedAt) {
        redirect("/suspended");
    }

    return session;
}

/** Redirect to dashboard if already authenticated. */
export async function redirectIfAuthenticated() {
    const session = await getSession();

    if (session?.user) {
        redirect("/dashboard");
    }
}

/**
 * API-route variant of `requireAuth`. Throws `AppError` on failure so
 * `apiHandler` produces the unified error envelope.
 *
 * Failure modes:
 *   - No session            -> AppError(AUTH_SESSION_MISSING, 401)
 *   - `users.suspendedAt`   -> AppError(ACCOUNT_SUSPENDED, 403)
 */
export async function requireApiSession(
    request: Request,
): Promise<NonNullable<Awaited<ReturnType<typeof getSession>>>> {
    const session = await auth.api.getSession({ headers: request.headers });
    if (!session?.user) {
        throw new AppError(ErrorCode.AUTH_SESSION_MISSING, "Unauthorized", 401);
    }

    const [u] = await db
        .select({ suspendedAt: users.suspendedAt })
        .from(users)
        .where(eq(users.id, session.user.id))
        .limit(1);

    if (u?.suspendedAt) {
        throw new AppError(
            ErrorCode.ACCOUNT_SUSPENDED,
            "Account suspended",
            403,
        );
    }

    return session;
}
