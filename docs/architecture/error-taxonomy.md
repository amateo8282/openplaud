# Error taxonomy pointer

The canonical reference for OpenPlaud's `ErrorCode` enum and how each
code is surfaced to clients lives in [../error-codes.md](../error-codes.md).

This pointer exists so contributors looking under `docs/architecture/`
for "why does the code throw `AppError` instead of plain `Error`?" can
find the answer.

## TL;DR

- `src/lib/errors.ts` defines the `ErrorCode` enum and the `AppError`
  class. Each `AppError` carries an HTTP status code, a stable string
  `code`, and optional `details`.
- Route handlers throw `AppError`s directly. `apiHandler`
  (`src/lib/api-handler.ts`) translates them into JSON responses with
  the right status. Unknown errors flatten to `INTERNAL_ERROR` (500).
- The Plaud-specific subset (`PLAUD_INVALID_TOKEN`,
  `PLAUD_UPSTREAM_ERROR`, `PLAUD_API_ERROR`, `PLAUD_RATE_LIMITED`,
  `PLAUD_WORKSPACE_UNAVAILABLE`, `PLAUD_OTP_INVALID`,
  `PLAUD_REGION_REDIRECT_LOOP`, `PLAUD_INVALID_API_BASE`) gives the UI
  enough information to decide whether to nudge the user to reconnect,
  retry later, or surface the upstream failure.

The mapping from HTTP status to `ErrorCode` is centralised in
`plaudHttpError` (`src/lib/plaud/client.ts`) and mirrored in
`safeParseJson` (`src/lib/plaud/parse.ts`) for the case where the
response body cannot be parsed as JSON.
