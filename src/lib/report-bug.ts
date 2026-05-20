// Bug-report URL builders. Field IDs must match
// `.github/ISSUE_TEMPLATE/bug_report.yml`. Pure and isomorphic.

import { APP_VERSION_TAG } from "@/lib/version";

export const SUPPORT_EMAIL = "support@openplaud.com";

const GITHUB_NEW_ISSUE_URL =
    "https://github.com/openplaud/openplaud/issues/new";
const BUG_REPORT_TEMPLATE = "bug_report.yml";

export interface ReportBugOptions {
    /** Correlation id from the error envelope. */
    errorId?: string;
    /** What the user was doing when the error fired. */
    errorContext?: string;
    /** Current page path (e.g. `/dashboard`). */
    page?: string;
    /**
     * Hosted vs self-host. Optional: client-side entry points don't
     * have `env.IS_HOSTED` available and leave the form field empty.
     */
    isHosted?: boolean;
}

/** Build a pre-filled GitHub Issue Form URL. */
export function buildReportBugUrl(opts: ReportBugOptions): string {
    const params = new URLSearchParams({
        template: BUG_REPORT_TEMPLATE,
        version: APP_VERSION_TAG,
    });

    const description = buildDescription(opts);
    if (description) {
        params.set("description", description);
    }

    if (opts.isHosted !== undefined) {
        params.set(
            "deployment",
            opts.isHosted ? "Hosted (openplaud.com)" : "Self-hosted",
        );
    }

    const additional = buildAdditional(opts);
    if (additional) {
        params.set("additional", additional);
    }

    return `${GITHUB_NEW_ISSUE_URL}?${params.toString()}`;
}

/** Build a pre-filled mailto URL. Hosted-only by caller convention. */
export function buildReportBugMailto(opts: ReportBugOptions): string {
    const subject = opts.errorId
        ? `OpenPlaud bug report (${opts.errorId})`
        : "OpenPlaud bug report";
    const body = [buildDescription(opts), "", "---", buildAdditional(opts)]
        .filter(Boolean)
        .join("\n");

    // RFC 6068 mailto requires `%20`; URLSearchParams emits `+`, which
    // some mail clients render literally. Encode manually.
    const qs = `subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
    return `mailto:${SUPPORT_EMAIL}?${qs}`;
}

/** Prose preview shown to the user before they click. */
export function buildReportBugBodyPreview(opts: ReportBugOptions): string {
    const parts = [buildDescription(opts), "", buildAdditional(opts)].filter(
        Boolean,
    );
    return parts.join("\n");
}

function buildDescription(opts: ReportBugOptions): string {
    const lines: string[] = [];
    if (opts.errorContext) {
        lines.push(`While trying to: ${opts.errorContext}`);
    }
    if (opts.errorId) {
        if (lines.length > 0) lines.push("");
        lines.push(`Error id: \`${opts.errorId}\``);
    }
    return lines.join("\n");
}

function buildAdditional(opts: ReportBugOptions): string {
    const lines: string[] = [];
    if (opts.page) {
        lines.push(`Page: \`${opts.page}\``);
    }
    lines.push(`Version: ${APP_VERSION_TAG}`);
    if (opts.isHosted !== undefined) {
        lines.push(
            `Mode: ${opts.isHosted ? "Hosted (openplaud.com)" : "Self-hosted"}`,
        );
    }
    return lines.join("\n");
}
