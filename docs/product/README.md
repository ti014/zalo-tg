# Product Documentation

This directory holds the current consumer-owned product contract for
`zalo-tg`. It is derived from accepted behavior in the root README,
`docs/operations.md`, implementation, and executable tests; those sources
remain authoritative when they conflict.

## Current Contract

- [Bridge overview](overview.md): scope, user-visible behavior, operating
  boundaries, and source-of-truth links for the Zalo–Telegram bridge.

Keep product documents small and domain-specific. Add a new document only when
an accepted user-visible contract cannot be kept clear in `overview.md`.

## Update Rule

When behavior changes:

1. Update the affected product document when the expected behavior changed.
2. Update the active execution plan when complex work uses one.
3. Add a lasting decision only when future work must inherit a consequential
   product, architecture, data, security, compatibility, or validation choice.
4. Add or update executable proof that exercises the behavior.

Bounded changes do not require a story packet, proof-matrix row, or Harness CLI
mutation.
