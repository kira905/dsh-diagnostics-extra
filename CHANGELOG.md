# Changelog

All notable changes to this project are documented here.
Format loosely follows [Keep a Changelog](https://keepachangelog.com/); versions follow SemVer.

## [Unreleased]

### Changed

- `owner-todo-scan.mjs`: dropped a redundant alternative from `SKIP_DIR` — the shorter entry
  already matches the longer one as a substring, so directory-skipping semantics are unchanged
  (equivalence check over 17 candidate names: 0 differences).

## [0.1.0] - 2026-10-19

### Added

- **`attachments-audit.mjs`** — read-only reconciliation of image attachments referenced by session
  logs against on-disk objects (`<DSH_HOME>/attachments/v1/objects/<2>/<sha256>`). Cache with
  relative-path + size + mtimeMs keys; `--json` / `--quiet` / `--no-cache` / `--sessions-only` /
  `--verify-objects`. Exit codes `0/3/2/4` (`4` = fail-closed environment unavailable).
- **`attachments-fetch.mjs`** — fetch missing objects by sha256 from explicit sources, relay
  directories or local derived sources; `--probe`, `--export`, `--rollback`, `--dry-run`, `--report`,
  `--force`; atomic placement (temp file → verify → rename → re-verify).
- **`dsh-why.mjs`** — one-command read-only health check: host, dsh main process (owner of the
  LISTEN socket on port 3080), guard bodies vs launchers, port connections, guard state and log tail;
  `--json`, `--log-lines`, `--procs-file`; secret-shaped output redacted.
- **`owner-todo-scan.mjs`** — merges owner-pending items from board-card descriptions, handoff
  documents and peer-machine run sheets; autonomy grade split (self / red-line / unknown);
  `--all` / `--json` / `--write` (writes `docs\your-todo-<device>.md`).
- Shared `lib/dsh-home.mjs`, `lib/attach-refs.mjs`, `lib/session-file-name.mjs`,
  `lib/powershell-exe.mjs`, `lib/redact.mjs`, `lib/generated-docs.mjs`.
- `package.json` with `bin` entries for all four CLIs, AGPL-3.0 + commercial dual licensing.

### Changed (relative to the private source tree)

- All machine-absolute paths replaced with `DSH_ROOT` / `os.homedir()` / environment variables /
  relative paths; host and user names replaced with generic placeholders.
- **`owner-todo-scan.mjs` upgrade-lock dependency**: the static `import { status } from
  './dsh-butler/lib/upgrade-lock.mjs'` became a **dynamic, optional load** from
  `DSH_TOOLS_DIR` / `DSH_BUTLER_LIB` with an explicit degraded branch. When the kernel is absent it
  prints one "upgrade lock: not probeable" line and continues; when present, the judged states are
  byte-for-byte the same as the private tree (no judging rule was copied or rewritten).
- `lane-gate.mjs` / `residue-reaper.mjs` dynamic paths are now resolved from `DSH_BUTLER_LIB` instead
  of a fixed absolute path (still optional, still silently skipped when absent).
- `dsh-why.mjs` device short code generalized: host name is slugified (override with
  `DSH_DEVICE_LABEL`); the two hard-coded machine names were removed.
- `owner-todo-scan.mjs` device label generalized (`DSH_DEVICE_LABEL`, default host name) and the
  peer-run-sheet judge made configurable (`DSH_PEER_LABEL`, default `对端机`).
- `lib/generated-docs.mjs`: `<host>` family placeholder generalized from a fixed two-host alternation
  to `([a-z][a-z0-9-]*)`; sample paths use `example-host`; the drive-letter prefix rule accepts both
  separators; fixture variants use a placeholder drive (`X:`) instead of a real one.
- `lib/powershell-exe.mjs`: hard-coded system paths are composed from `SystemDrive` / `SystemRoot` /
  `ProgramFiles` fallbacks instead of literal drive paths.

### Notes

- **`owner-todo-scan.mjs` has no help flag**: unknown arguments are ignored and the real action runs
  (`--write` writes the list). The other three scripts reject unknown arguments with usage.
- Write actions exist only in `attachments-fetch.mjs` (dry-run available) and
  `owner-todo-scan.mjs --write`.
- No network calls, no credential reads.
