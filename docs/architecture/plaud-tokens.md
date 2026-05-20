# Plaud token model

Plaud's API uses two distinct JSON Web Tokens. OpenPlaud has to mint and
juggle both of them, and the distinction is not obvious from the code
alone. This document records the model so the comments in
`src/lib/plaud/client.ts` and `src/lib/plaud/workspace.ts` can stay
focused on mechanics.

## The two tokens

### User Token (UT)

- `typ` claim: `"UT"`.
- Issued by `POST /auth/otp-login` at the end of the email-OTP login
  flow, or pasted directly into the "Connect via token" UI.
- Long-lived. Observed `exp` values sit around 300 days from issue.
- Authenticates the user-scoped endpoints: `/user/me`,
  `/team-app/workspaces/list`, and the workspace-token mint endpoint.
- Stored encrypted in `plaud_connections.bearer_token` (AES-256-GCM
  via `src/lib/encryption.ts`).

### Workspace Token (WT)

- `typ` claim: `"WT"`.
- Minted from a UT via
  `POST /user-app/auth/workspace/token/{workspace_id}`.
- Short-lived: 24 hours.
- Required by the recording-scoped endpoints: `/file/simple/web`,
  `/device/list`, `/file/temp-url/*`, `/filetag/`, and friends.
- Not persisted. Each `PlaudClient` instance mints a fresh WT lazily on
  its first authenticated request and caches it for the lifetime of
  that instance.

The `workspace_id` itself is persisted in
`plaud_connections.workspace_id` so subsequent runs can skip the
`/team-app/workspaces/list` round-trip and mint a WT directly.

## Why both tokens exist in our code

On Plaud's regional servers (EU, APAC), sending a UT directly to a
recording endpoint such as `/file/simple/web` returns `HTTP 200` with
an empty result list. The request silently fails open — no error, no
indication that anything is wrong — which produced issue #66 (sync
appeared to work, returned zero recordings).

Switching to a WT for recording endpoints fixes this. The global
server historically accepted the UT directly on these endpoints, so
`PlaudClient` keeps a UT-fallback path for backwards compatibility:
if the WT mint fails, it logs and continues with the UT. The dev info
endpoint surfaces whether a connection is in this fallback state.

## Refresh handling

There isn't any. Plaud's OTP login flow does not return a refresh
token (commit `bed9cd3` removed the speculative refresh-token plumbing
that previously existed). When a UT eventually expires, users
reconnect via the standard reconnect flow in settings.

A WT lasts 24 hours, which is far longer than any sync run, so no
in-flight WT refresh is needed.

## Decoding tokens locally

`decodeAccessTokenExpiry` in `src/lib/plaud/auth.ts` decodes a UT's
`exp` claim without verifying the signature. This is UX-only — the
paste-token UI uses it to show "this token expires in N days". Real
validation always happens by hitting Plaud's `/device/list` with the
token; nothing in the codebase trusts decoded JWT payload values for
any authorisation decision.
