import { readFile } from "node:fs/promises";
import path from "node:path";

/**
 * Render `scripts/install.sh` with `{{VERSION}}` substituted.
 *
 * The standalone Next.js output excludes files outside the build graph;
 * `next.config.ts` must declare `outputFileTracingIncludes` for both
 * `/install.sh` and `/[version]/install.sh` so this read succeeds in
 * the Docker image.
 */

const VERSION_RE = /^v\d+\.\d+\.\d+$/;

let cachedScript: string | null = null;

async function loadScript(): Promise<string> {
    if (cachedScript !== null) return cachedScript;
    const scriptPath = path.join(process.cwd(), "scripts", "install.sh");
    cachedScript = await readFile(scriptPath, "utf-8");
    return cachedScript;
}

export function isValidVersionTag(value: string): boolean {
    return VERSION_RE.test(value);
}

export async function renderInstallScript(version: string): Promise<string> {
    const script = await loadScript();
    return script.replaceAll("{{VERSION}}", version);
}

/**
 * Latest release tag from GitHub. Cached for 5 min via Next's fetch
 * cache (unauthenticated GitHub limit is 60 req/hr). Returns `null` on
 * any failure — callers should fall back to a baked-in default.
 */
export async function fetchLatestReleaseTag(): Promise<string | null> {
    try {
        const res = await fetch(
            "https://api.github.com/repos/openplaud/openplaud/releases/latest",
            {
                headers: {
                    Accept: "application/vnd.github+json",
                    "X-GitHub-Api-Version": "2022-11-28",
                },
                next: { revalidate: 300 },
            },
        );
        if (!res.ok) return null;
        const data = (await res.json()) as { tag_name?: unknown };
        const tag = typeof data.tag_name === "string" ? data.tag_name : null;
        if (tag && isValidVersionTag(tag)) return tag;
        return null;
    } catch {
        return null;
    }
}

export const INSTALL_SCRIPT_HEADERS: Record<string, string> = {
    "Content-Type": "text/x-shellscript; charset=utf-8",
    "Cache-Control": "public, max-age=60, s-maxage=300",
    "X-Content-Type-Options": "nosniff",
};
