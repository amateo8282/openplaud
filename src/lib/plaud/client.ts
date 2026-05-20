import { AppError, ErrorCode } from "@/lib/errors";
import type {
    PlaudApiError,
    PlaudDeviceListResponse,
    PlaudRecordingsResponse,
    PlaudTempUrlResponse,
} from "@/types/plaud";
import { plaudFetch } from "./fetch";
import { safeParseJson } from "./parse";
import { DEFAULT_SERVER_KEY, PLAUD_SERVERS, PLAUD_USER_AGENT } from "./servers";
import { resolveWorkspaceToken } from "./workspace";

export interface PlaudUpdateFilenameResponse {
    status: number;
    msg: string;
    data_file?: unknown;
}

export const DEFAULT_PLAUD_API_BASE = PLAUD_SERVERS[DEFAULT_SERVER_KEY].apiBase;
const MAX_RETRIES = 3;
const INITIAL_RETRY_DELAY = 1000; // 1 second

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Map a Plaud HTTP failure to a structured `AppError`:
 *   401 → PLAUD_INVALID_TOKEN (reconnect path)
 *   4xx → PLAUD_API_ERROR (surfaced as 400)
 *   5xx → PLAUD_UPSTREAM_ERROR (surfaced as 502, after MAX_RETRIES).
 */
function plaudHttpError(status: number, msg: string): AppError {
    if (status === 401) {
        return new AppError(
            ErrorCode.PLAUD_INVALID_TOKEN,
            "Plaud rejected the access token. Reconnect your Plaud account.",
            401,
            { plaudStatus: status, plaudMessage: msg },
        );
    }
    if (status >= 500) {
        return new AppError(
            ErrorCode.PLAUD_UPSTREAM_ERROR,
            "Plaud is temporarily unavailable. Please try again later.",
            502,
            { plaudStatus: status, plaudMessage: msg },
        );
    }
    return new AppError(ErrorCode.PLAUD_API_ERROR, msg, 400, {
        plaudStatus: status,
    });
}

/**
 * Plaud API client. Takes a UT in its constructor and lazily mints a WT
 * for recording endpoints; falls back to the UT directly if the mint
 * fails. See `docs/architecture/plaud-tokens.md`.
 */
export class PlaudClient {
    private readonly userToken: string;
    private readonly apiBase: string;
    private workspaceToken?: string;
    private resolvedWorkspaceId?: string;
    private workspaceFetchInFlight?: Promise<void>;
    private workspaceFallbackToUt = false;

    constructor(
        userToken: string,
        apiBase: string = DEFAULT_PLAUD_API_BASE,
        workspaceId?: string | null,
    ) {
        this.userToken = userToken;
        this.apiBase = apiBase;
        this.resolvedWorkspaceId = workspaceId ?? undefined;
    }

    /**
     * Currently-known workspace ID. Populated by the constructor (cache
     * hit) or after the first authenticated request. Callers persist
     * this back to the DB when it differs from what they passed in.
     */
    get workspaceId(): string | undefined {
        return this.resolvedWorkspaceId;
    }

    /** Whether this client fell back to the UT because WT mint failed. */
    get usingUserTokenFallback(): boolean {
        return this.workspaceFallbackToUt;
    }

    /**
     * Lazily ensure a workspace token is available. Concurrent callers
     * share a single in-flight resolution so we don't mint multiple WTs.
     */
    private async ensureWorkspaceToken(): Promise<void> {
        if (this.workspaceToken || this.workspaceFallbackToUt) return;
        if (!this.workspaceFetchInFlight) {
            this.workspaceFetchInFlight = this.fetchWorkspaceToken();
        }
        try {
            await this.workspaceFetchInFlight;
        } finally {
            this.workspaceFetchInFlight = undefined;
        }
    }

    private async fetchWorkspaceToken(): Promise<void> {
        try {
            const { workspaceToken, workspaceId } = await resolveWorkspaceToken(
                this.userToken,
                this.apiBase,
                this.resolvedWorkspaceId,
            );
            this.workspaceToken = workspaceToken;
            this.resolvedWorkspaceId = workspaceId;
        } catch (err) {
            // Fall back to the UT directly. Logged so the dev info
            // endpoint can surface that the connection is in fallback.
            console.warn(
                "[plaud] workspace token mint failed, falling back to user token:",
                err instanceof Error ? err.message : err,
            );
            this.workspaceFallbackToUt = true;
        }
    }

    /**
     * Authenticated request with retry on 429 (honours Retry-After), 5xx,
     * and `TypeError` from fetch. Up to `MAX_RETRIES` attempts with
     * exponential backoff.
     */
    private async request<T>(
        endpoint: string,
        options?: RequestInit,
        retryCount = 0,
    ): Promise<T> {
        await this.ensureWorkspaceToken();

        const bearer = this.workspaceToken ?? this.userToken;
        const url = `${this.apiBase}${endpoint}`;

        try {
            const response = await plaudFetch(url, {
                ...options,
                headers: {
                    ...options?.headers,
                    Authorization: `Bearer ${bearer}`,
                    "Content-Type": "application/json",
                    "User-Agent": PLAUD_USER_AGENT,
                },
            });

            if (response.status === 429) {
                if (retryCount < MAX_RETRIES) {
                    const retryAfter = response.headers.get("Retry-After");
                    const delay = retryAfter
                        ? Number.parseInt(retryAfter, 10) * 1000
                        : INITIAL_RETRY_DELAY * 2 ** retryCount; // Exponential backoff
                    await sleep(delay);
                    return this.request<T>(endpoint, options, retryCount + 1);
                }
                const retryAfter = response.headers.get("Retry-After");
                throw new AppError(
                    ErrorCode.PLAUD_RATE_LIMITED,
                    "Too many requests to Plaud. Please try again later.",
                    429,
                    retryAfter
                        ? { retryAfter: Number.parseInt(retryAfter, 10) }
                        : undefined,
                );
            }

            if (!response.ok) {
                const error = (await response
                    .json()
                    .catch(() => ({}) as PlaudApiError)) as PlaudApiError;
                const upstreamMsg = error.msg || response.statusText;

                if (
                    response.status >= 500 &&
                    response.status < 600 &&
                    retryCount < MAX_RETRIES
                ) {
                    const delay = INITIAL_RETRY_DELAY * 2 ** retryCount;
                    await sleep(delay);
                    return this.request<T>(endpoint, options, retryCount + 1);
                }

                throw plaudHttpError(response.status, upstreamMsg);
            }

            return await safeParseJson<T>(response);
        } catch (error) {
            if (
                error instanceof TypeError &&
                error.message.includes("fetch") &&
                retryCount < MAX_RETRIES
            ) {
                const delay = INITIAL_RETRY_DELAY * 2 ** retryCount;
                await sleep(delay);
                return this.request<T>(endpoint, options, retryCount + 1);
            }

            if (error instanceof AppError) throw error;
            // Network blow-up / DNS / AbortError past the retry budget,
            // or a body that failed parsing. Surface as PLAUD_UPSTREAM_ERROR
            // rather than letting apiHandler downgrade to INTERNAL_ERROR.
            throw new AppError(
                ErrorCode.PLAUD_UPSTREAM_ERROR,
                "Failed to communicate with Plaud. Please try again later.",
                502,
            );
        }
    }

    async listDevices(): Promise<PlaudDeviceListResponse> {
        return this.request<PlaudDeviceListResponse>("/device/list");
    }

    /**
     * @param skip - Number of recordings to skip
     * @param limit - Maximum number of recordings to return
     * @param isTrash - 0 = active, 1 = trash
     * @param sortBy - Field to sort by (default: edit_time)
     * @param isDesc - Sort in descending order (default: true)
     */
    async getRecordings(
        skip: number = 0,
        limit: number = 99999,
        isTrash: number = 0,
        sortBy: string = "edit_time",
        isDesc: boolean = true,
    ): Promise<PlaudRecordingsResponse> {
        const params = new URLSearchParams({
            skip: skip.toString(),
            limit: limit.toString(),
            is_trash: isTrash.toString(),
            sort_by: sortBy,
            is_desc: isDesc.toString(),
        });

        return this.request<PlaudRecordingsResponse>(
            `/file/simple/web?${params.toString()}`,
        );
    }

    /**
     * @param fileId - The recording file ID
     * @param isOpus - Whether to get OPUS format URL (default: true)
     */
    async getTempUrl(
        fileId: string,
        isOpus: boolean = true,
    ): Promise<PlaudTempUrlResponse> {
        const params = new URLSearchParams({
            is_opus: isOpus ? "1" : "0",
        });

        return this.request<PlaudTempUrlResponse>(
            `/file/temp-url/${fileId}?${params.toString()}`,
        );
    }

    /**
     * @param fileId - The recording file ID
     * @param preferOpus - Whether to prefer OPUS format (smaller size)
     */
    async downloadRecording(
        fileId: string,
        preferOpus: boolean = true,
    ): Promise<Buffer> {
        try {
            const tempUrlResponse = await this.getTempUrl(fileId, preferOpus);
            const downloadUrl =
                preferOpus && tempUrlResponse.temp_url_opus
                    ? tempUrlResponse.temp_url_opus
                    : tempUrlResponse.temp_url;

            // resource.plaud.ai is in the same proxy scope as the API.
            const response = await plaudFetch(downloadUrl);
            if (!response.ok) {
                throw new AppError(
                    ErrorCode.PLAUD_UPSTREAM_ERROR,
                    "Failed to download recording from Plaud. Please try again later.",
                    502,
                    { plaudStatus: response.status },
                );
            }

            const arrayBuffer = await response.arrayBuffer();
            return Buffer.from(arrayBuffer);
        } catch (error) {
            if (error instanceof AppError) throw error;
            throw new AppError(
                ErrorCode.PLAUD_UPSTREAM_ERROR,
                "Failed to download recording from Plaud. Please try again later.",
                502,
            );
        }
    }

    /** Returns true if the bearer token is accepted by /device/list. */
    async testConnection(): Promise<boolean> {
        try {
            await this.listDevices();
            return true;
        } catch {
            return false;
        }
    }

    /**
     * @param fileId - The recording file ID
     * @param filename - New filename to set
     */
    async updateFilename(
        fileId: string,
        filename: string,
    ): Promise<PlaudUpdateFilenameResponse> {
        return this.request<PlaudUpdateFilenameResponse>(`/file/${fileId}`, {
            method: "PATCH",
            body: JSON.stringify({ filename }),
        });
    }
}

export * from "./types";

// `createPlaudClient` (which decrypts the stored bearer token) lives in
// ./client-factory so importing this class from tests doesn't pull in
// the encryption / env validation chain.
