# 11. Scenarios are recorded days; the corpus is gone

Date: 2026-10-07
Status: Accepted

Supersedes the corpus decision of ADR 0010 and its amendment to ADR 0008, "the truth is the feed log and the archive".
ADR 0010's poll fallback stays in force.

## Context

ADR 0010 built game days as typed corpus files, from the feed log (captured) or synthesized from an archive of ESPN's
finished games (backfilled), and played them through the slate on virtual time. The scenarios the Hub plays are a
second way to replay a day, through the real Ingest, feed log, decode and slate. The corpus kept a second copy of the
day beside the log, in a format that is rebuilt whenever a decoder changes, and backfilled days were synthesized from
a lag model, not from what the Hub saw. Two ways to replay one day is one too many, and only the one that runs the
real path tests what ships.

## Decision

- **A scenario is a recorded game day.** The feed log is the one record of a day, and a scenario plays frames from it,
  as the Hub received them.
- **The corpus and the archive are removed**: the `corpus` command and its worker threads, typed days and their
  builders, the synthesis and lag model, the `Archiver` port and ESPN's adapter of it, and `HubConfig.corpusDir`
  (`SPORTAL_CORPUS_DIR`).
- **The truth is the feed log.** Amending ADR 0008 again: the feed log is the truth of what the Hub saw; there is no
  archive of what ESPN gave afterwards.

## Consequences

- A day the Hub did not see cannot be played; there are no backfilled days.
- Nothing is built, rebuilt or migrated: a decoder change needs no step between the log and a run.
- The Hub no longer uses `effect/cli` or `effect/workers`; both leave `allowedUnstableApis`.
- ADR 0010's measurements of corpus runs and backfills no longer describe anything the repository has.
