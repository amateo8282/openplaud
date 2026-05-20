// Shared audio-file construction for the server-side OpenAI-style
// transcription path. OGG containers are detected by magic bytes so
// the content-type stays correct regardless of filename extension.

import { getAudioMimeType } from "@/lib/utils";

export interface BuildAudioFileResult {
    file: File;
    contentType: string;
}

/** Detect OGG by the `OggS` magic bytes. */
function isOggContainer(audioBuffer: Buffer): boolean {
    if (audioBuffer.length < 4) return false;
    return (
        audioBuffer[0] === 0x4f && // O
        audioBuffer[1] === 0x67 && // g
        audioBuffer[2] === 0x67 && // g
        audioBuffer[3] === 0x53 // S
    );
}

/**
 * Build the `File` passed to `openai.audio.transcriptions.create`.
 *
 * @param storagePath On-disk path (extension hint when buffer is not OGG).
 * @param decryptedFilename User-facing filename (post-decrypt). An
 *   extension is appended when missing so providers that key off the
 *   filename get a clean hint.
 */
export function buildAudioFile(
    audioBuffer: Buffer,
    storagePath: string,
    decryptedFilename: string,
): BuildAudioFileResult {
    const isOgg = isOggContainer(audioBuffer);

    const ext = isOgg
        ? "ogg"
        : storagePath.split(".").pop()?.toLowerCase() || "mp3";

    // OGG magic byte overrides the path-derived guess.
    const contentType = isOgg ? "audio/ogg" : getAudioMimeType(storagePath);

    const filename = decryptedFilename.match(/\.\w{2,4}$/)
        ? decryptedFilename
        : `${decryptedFilename}.${ext}`;

    // Zero-copy view over the existing Buffer. `Buffer.buffer` is
    // `ArrayBufferLike`; Node never backs a Buffer with a
    // SharedArrayBuffer in normal flows, so the cast is safe and skips
    // the full-audio copy that `new Uint8Array(buffer)` would force.
    const view = new Uint8Array(
        audioBuffer.buffer as ArrayBuffer,
        audioBuffer.byteOffset,
        audioBuffer.byteLength,
    );
    const file = new File([view], filename, {
        type: contentType,
    });

    return { file, contentType };
}
