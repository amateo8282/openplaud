# Architecture Notes

Design rationale and implementation context that doesn't fit in source
comments. Living documents — updated whenever the underlying decisions
change.

The goal of this directory is to keep `src/` free of long narrative
comments while still giving new contributors a place to find the "why"
behind non-obvious code.

## Index

- [http-client.md](./http-client.md) — outbound HTTP layer used for
  Plaud API calls: proxy selection, retry strategy, and how the various
  defensive layers compose.
- [plaud-tokens.md](./plaud-tokens.md) — Plaud's two-tier token model
  (User Token vs Workspace Token) and how `PlaudClient` resolves them.
- [error-taxonomy.md](./error-taxonomy.md) — short pointer to the
  user-facing error code catalogue and how route handlers map upstream
  failures into it.

## When to add an entry

If you find yourself writing more than a short paragraph of comment to
explain *why* a piece of code is shaped the way it is, write it here
instead and reference the file from the source. Mechanics, type-level
notes, race conditions, and security invariants stay in the source —
those are the things a reader needs while looking at the code.
