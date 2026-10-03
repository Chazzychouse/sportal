# 5. Workspace packages are consumed as source

Date: 2026-10-03
Status: Accepted

## Context

`packages/domain` and `packages/api` are used by the Hub (Node), the web UI (Vite), and the shell
(electron-vite).

## Decision

Packages have no build step. Their `exports` map points at `src/*.ts`. Node 24 runs the Hub's
TypeScript directly; `erasableSyntaxOnly` in the shared compiler options guarantees that stays
possible. Vite and electron-vite compile the same source for the browser and the shell.

## Consequences

No build ordering, no stale output, one definition reachable by go-to-definition. TypeScript syntax
that needs code generation (enums, parameter properties, namespaces) is unavailable, which the coding
rules already forbid.
