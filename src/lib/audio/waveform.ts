// Client-side waveform peak extraction. Browser-decoded so no
// server-side audio toolchain is required.

export const DEFAULT_BUCKETS = 500;

/**
 * Upper bound for automatic decode. Above this, the player shows a
 * manual "Generate waveform" button to avoid hundreds of MB of
 * transient PCM allocations on long files.
 */
export const AUTO_DECODE_MAX_MS = 30 * 60 * 1000;

let sharedCtx: AudioContext | null = null;

// Lazily-instantiated, page-lifetime-bound AudioContext. Safari limits
// total active contexts, so we share one and never close it.
function getAudioContext(): AudioContext {
    if (sharedCtx) return sharedCtx;
    // Older Safari only ships `webkitAudioContext`; lib.dom doesn't
    // include the prefix, so read it off `window` via index lookup.
    const Ctx: typeof AudioContext | undefined =
        typeof AudioContext !== "undefined"
            ? AudioContext
            : ((window as unknown as Record<string, unknown>)
                  .webkitAudioContext as typeof AudioContext | undefined);
    if (!Ctx) {
        throw new Error("Web Audio API not available");
    }
    sharedCtx = new Ctx();
    return sharedCtx;
}

export interface PeaksResult {
    peaks: number[];
    /** Per-channel frame count (`audio.length`). */
    sampleCount: number;
    /** Decoded audio length in seconds. */
    durationSeconds: number;
}

/**
 * Decode an audio buffer and return normalised envelope peaks in
 * `[0, 1]`. Throws on undecodable input — callers should fall back to
 * a plain progress bar.
 */
export async function decodePeaks(
    arrayBuffer: ArrayBuffer,
    buckets: number = DEFAULT_BUCKETS,
): Promise<PeaksResult> {
    // Mirrors the server-side bounds; out-of-range would 400 anyway.
    if (buckets < 32 || buckets > 2048) {
        throw new Error("buckets must be between 32 and 2048");
    }

    const ctx = getAudioContext();
    const audio = await ctx.decodeAudioData(arrayBuffer);

    const channelCount = audio.numberOfChannels;
    const length = audio.length;

    // Mix-down to mono inline while computing per-bucket max.
    const peaks = new Float32Array(buckets);
    const samplesPerBucket = Math.max(1, Math.floor(length / buckets));

    // Cache channel refs; getChannelData() is not free on Chromium.
    const channels: Float32Array[] = [];
    for (let c = 0; c < channelCount; c++) {
        channels.push(audio.getChannelData(c));
    }

    for (let b = 0; b < buckets; b++) {
        const start = b * samplesPerBucket;
        const end = Math.min(start + samplesPerBucket, length);
        let peak = 0;
        for (let i = start; i < end; i++) {
            let sum = 0;
            for (let c = 0; c < channelCount; c++) {
                sum += channels[c][i];
            }
            const v = Math.abs(sum / channelCount);
            if (v > peak) peak = v;
        }
        peaks[b] = peak;
    }

    // Loudest bucket -> 1.0. Silent files (peak == 0) render flat,
    // visually distinct from "no data" (which falls back to the slider).
    let maxPeak = 0;
    for (let i = 0; i < buckets; i++) {
        if (peaks[i] > maxPeak) maxPeak = peaks[i];
    }

    const out = new Array<number>(buckets);
    if (maxPeak > 0) {
        const inv = 1 / maxPeak;
        for (let i = 0; i < buckets; i++) {
            out[i] = peaks[i] * inv;
        }
    } else {
        for (let i = 0; i < buckets; i++) {
            out[i] = 0;
        }
    }

    return {
        peaks: out,
        sampleCount: length,
        durationSeconds: audio.duration,
    };
}
