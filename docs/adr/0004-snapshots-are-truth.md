# 4. Snapshots are the truth

Date: 2026-10-03
Status: Accepted

## Context

The data feed is polled, unofficial, and can miss or repeat updates.

## Decision

The Hub's state is the latest `GameSnapshot` per game. Anything event-like is derived by comparing
snapshots and is never stored as the source of truth. On a provider failure the last good slate for
that league is kept.

## Consequences

A restart or a missed poll cannot corrupt state. Events can be lost across a restart, which is
acceptable because nothing depends on having seen every one.
