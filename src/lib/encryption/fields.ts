import { decrypt, encrypt } from "@/lib/encryption";

// Field-level envelope encryption (AES-256-GCM) over
// `src/lib/encryption.ts`. Threat model and rollout notes:
// `docs/encryption-at-rest.md`.

const VERSION_PREFIX = "v1:";

// Strict shape for the base `encrypt()` output:
// `<32 hex IV>:<32 hex tag>:<even-length hex ciphertext>`.
// The trailing `(?:[0-9a-f]{2})*` admits the empty case (encrypting
// `""` is a valid round-trip) and rejects odd-length hex, which AES-GCM
// can never produce.
const RAW_CIPHERTEXT_SHAPE = /^[0-9a-f]{32}:[0-9a-f]{32}:(?:[0-9a-f]{2})*$/i;

// Match the full shape after the `v1:` prefix so a plaintext that
// happens to start with `v1:` is not misclassified as ciphertext.
const V1_CIPHERTEXT_SHAPE = /^v1:[0-9a-f]{32}:[0-9a-f]{32}:(?:[0-9a-f]{2})*$/i;

function isCiphertext(value: string): boolean {
    if (V1_CIPHERTEXT_SHAPE.test(value)) return true;
    return RAW_CIPHERTEXT_SHAPE.test(value);
}

/**
 * Encrypt a string for storage in a `text` column, prefixed with `v1:`.
 * Empty strings round-trip; `null`/`undefined` pass through.
 */
export function encryptText(plaintext: string): string;
export function encryptText(plaintext: null): null;
export function encryptText(plaintext: undefined): undefined;
export function encryptText(
    plaintext: string | null | undefined,
): string | null | undefined;
export function encryptText(
    plaintext: string | null | undefined,
): string | null | undefined {
    if (plaintext === null) return null;
    if (plaintext === undefined) return undefined;
    return `${VERSION_PREFIX}${encrypt(plaintext)}`;
}

/**
 * Decrypt a value read from a `text` column.
 *
 * - `v1:` prefix → strip and decrypt under the current key.
 * - Bare `iv:tag:ct` shape → decrypt directly.
 * - Anything else → treat as legacy plaintext and return verbatim.
 *
 * Tampering (valid shape, invalid GCM tag) raises — AES-GCM is meant
 * to surface that loud, not silent.
 */
export function decryptText(value: string): string;
export function decryptText(value: null): null;
export function decryptText(value: undefined): undefined;
export function decryptText(
    value: string | null | undefined,
): string | null | undefined;
export function decryptText(
    value: string | null | undefined,
): string | null | undefined {
    if (value === null) return null;
    if (value === undefined) return undefined;
    if (V1_CIPHERTEXT_SHAPE.test(value)) {
        return decrypt(value.slice(VERSION_PREFIX.length));
    }
    if (RAW_CIPHERTEXT_SHAPE.test(value)) {
        return decrypt(value);
    }
    return value;
}

/**
 * jsonb-envelope encryption for fields stored as JSON. The column stays
 * `jsonb` and the value becomes `{ "c": "<v1:…>" }` so the schema does
 * not change.
 */
export interface EncryptedJsonEnvelope {
    c: string;
}

function isEnvelope(value: unknown): value is EncryptedJsonEnvelope {
    return (
        typeof value === "object" &&
        value !== null &&
        !Array.isArray(value) &&
        "c" in value &&
        typeof (value as { c: unknown }).c === "string"
    );
}

// Overload order matters: TS picks the first matching signature, so
// specific `null`/`undefined` overloads must precede the generic `<T>`.
export function encryptJsonField(value: null): null;
export function encryptJsonField(value: undefined): undefined;
export function encryptJsonField<T>(value: T): EncryptedJsonEnvelope;
export function encryptJsonField<T>(
    value: T | null | undefined,
): EncryptedJsonEnvelope | null | undefined;
export function encryptJsonField<T>(
    value: T | null | undefined,
): EncryptedJsonEnvelope | null | undefined {
    if (value === null) return null;
    if (value === undefined) return undefined;
    return { c: `${VERSION_PREFIX}${encrypt(JSON.stringify(value))}` };
}

/**
 * Decrypt a jsonb field. Envelope `{ c: "v1:…" }` is decrypted and
 * `JSON.parse`d; any other JSON shape is treated as legacy plaintext.
 * `T` is the *expected* shape on the encrypted-write path.
 */
export function decryptJsonField<T>(value: unknown): T | null {
    if (value === null || value === undefined) return null;
    if (isEnvelope(value)) {
        const inner = V1_CIPHERTEXT_SHAPE.test(value.c)
            ? value.c.slice(VERSION_PREFIX.length)
            : value.c;
        return JSON.parse(decrypt(inner)) as T;
    }
    return value as T;
}

/** Predicate for the backfill script's idempotency check. */
export function isEncryptedText(value: string | null | undefined): boolean {
    if (value === null || value === undefined) return false;
    return isCiphertext(value);
}

export function isEncryptedJsonField(value: unknown): boolean {
    return isEnvelope(value);
}
