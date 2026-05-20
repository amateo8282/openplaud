/**
 * Per-user rate limit for `POST /api/plaud/sync`.
 *
 * Multi-process safe: backed by the `apiRateLimitBuckets` Postgres table
 * via `consumeRateLimitBucket`, so it holds across hosted-mode workers.
 * Complements client-side dedup in `use-auto-sync.ts` and in-process
 * promise dedup in `syncRecordingsForUser`.
 */

import { NextResponse } from "next/server";
import { env } from "@/lib/env";
import { ErrorCode } from "@/lib/errors";
import { consumeRateLimitBucket } from "@/lib/rate-limit";

const WINDOW_MS = 60_000;

/**
 * Consume one token from the per-user sync bucket. Returns `null` when
 * the request is allowed, or a ready-to-return 429 `NextResponse` when
 * the bucket is exhausted.
 *
 *     const limited = await enforcePlaudSyncRateLimit(userId);
 *     if (limited) return limited;
 */
export async function enforcePlaudSyncRateLimit(
    userId: string,
): Promise<NextResponse | null> {
    const limit = env.PLAUD_SYNC_RATE_LIMIT_PER_MINUTE;
    const result = await consumeRateLimitBucket(`plaud-sync:user:${userId}`, {
        limit,
        windowMs: WINDOW_MS,
    });

    if (result.allowed) return null;

    const retryAfter = Math.max(
        1,
        Math.ceil((result.resetAt.getTime() - Date.now()) / 1000),
    );
    const resetAt = Math.ceil(result.resetAt.getTime() / 1000);

    return NextResponse.json(
        {
            error: "You are syncing too often. Please wait a moment and try again.",
            code: ErrorCode.RATE_LIMITED,
            details: {
                retryAfter,
                limit: result.limit,
                remaining: result.remaining,
                resetAt,
            },
        },
        {
            status: 429,
            headers: {
                "Retry-After": retryAfter.toString(),
                "X-RateLimit-Limit": result.limit.toString(),
                "X-RateLimit-Remaining": result.remaining.toString(),
                "X-RateLimit-Reset": resetAt.toString(),
            },
        },
    );
}
