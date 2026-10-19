# dsh-diagnostics-extra · Diagnostics & reconciliation utilities for DSH

> A small set of **read-only diagnostic tools** that actually get run when DeepSeek Harness (DSH)
> misbehaves: **image-attachment reconciliation / recovery** (why a session synced from another
> machine fails with TRANSPORT on the next turn), **one-command "what is running where"**
> (host / dsh & guard start times / connections on port 3080 / guard log tail), and an
> **"owner action required" scanner** that merges pending decisions from board cards,
> handoff documents and peer-machine run sheets.
>
> All tools run on **Node.js ≥ 20** with **zero third-party runtime dependencies** (`node:` builtins only). Windows-first.

---

## ⚠️ Read this first (more important than any usage example)

1. **One of the four scripts silently ignores unknown arguments and then executes the real action.**
   `owner-todo-scan.mjs` decides switches by "is the flag present"; it has **no help flag**.
   Typing an unrecognized argument will not stop it, and with `--write` it **rewrites
   `docs\your-todo-<device>.md`**. ⇒ Read that script's header comment (first 25 lines) or copy
   the exact flags from the per-tool table below.
2. **The other three are safe**: `attachments-audit.mjs`, `attachments-fetch.mjs` and `dsh-why.mjs`
   implement `-h` / help output and **reject unknown arguments by printing usage instead of acting**.
   Still, this document gives no help examples inside code blocks — the four tools differ enough
   that copying the per-tool table is safest.
3. **Only two write paths exist**: `attachments-fetch.mjs` materializes missing objects
   (supports `--dry-run` preview, `--report` and `--rollback`) and `owner-todo-scan.mjs --write`
   rewrites the pending list. Everything else is read-only.
4. These tools make **no network requests** and **never read credential files**. They only read
   your local DSH data root and docs tree.

---

## 1. Requirements & install

```powershell
# Node 20+; no npm install needed (zero deps)
node --version

# Run from the repository root
node attachments-audit.mjs --json
node dsh-why.mjs --log-lines 20

# Or install globally and use the bin names
npm i -g @kira905/dsh-diagnostics-extra
dsh-attachments-audit --json
```

### Environment variables (all optional)

| Variable | Meaning | Default |
|---|---|---|
| `DSH_ROOT` | DSH workspace root (the tree holding `docs\`, `tools\`, `_archive\`) | `~/DSH` |
| `DSH_HOME` / `BUTLER_DSH_HOME` | DSH home (`sessions`, `attachments`, `task-board`) | `~/.dsh` |
| `DSH_WORKSPACE` | Overrides workspace-root resolution | derived from `DSH_HOME` / `DSH_ROOT` |
| `DSH_DOCS_DIR` | Docs directory scanned by `owner-todo-scan` | `<workspace>/docs` |
| `DSH_TOOLS_DIR` | DSH tools root (parent of the optional kernel) | `<workspace>/tools` |
| `DSH_BUTLER_LIB` | Optional kernel directory (`upgrade-lock.mjs` / `lane-gate.mjs` / `residue-reaper.mjs`) | `<DSH_TOOLS_DIR>/dsh-butler/lib` |
| `DSH_DEVICE_LABEL` | Device label (list filename / health-check short code) | host name |
| `DSH_PEER_LABEL` | What "the peer machine" is called in your setup (peer-run-sheet judge) | `对端机` |
| `DSH_ATTACH_RELAY` | Attachment relay directory (highest priority for `attachments-fetch`) | see §3.2 |

> These tools grew inside a private working tree. The published version replaces every
> machine-absolute path with `DSH_ROOT` / `os.homedir()` / environment variables + relative paths,
> and replaces host names and user names with generic placeholders.
> Set `DSH_ROOT` on your machine first, otherwise `docs\` is looked up under `~/DSH`.

---

## 2. Repository layout (every file)

```
dsh-diagnostics-extra/
├── attachments-audit.mjs        # referenced image attachments vs local objects: read-only reconciliation
├── attachments-fetch.mjs        # fetch missing objects by sha256 / export / rollback (writes; dry-run available)
├── dsh-why.mjs                  # read-only health check: host / dsh & guard start times / port 3080 / log tail
├── owner-todo-scan.mjs          # scans pending owner actions (--write rewrites the list)
├── lib/
│   ├── dsh-home.mjs             # DSH home / workspace / report directory resolution
│   ├── attach-refs.mjs          # attachment references in session logs + object paths (sha256)
│   ├── session-file-name.mjs    # session log filename judge (all generations; avoids exact-name blindness)
│   ├── powershell-exe.mjs       # PowerShell interpreter selection (pwsh 7 first, 5.1 fallback)
│   ├── redact.mjs               # output redaction (key-name or value-shape; display only)
│   └── generated-docs.mjs       # generated-document markers and family matching (pure constants + functions)
├── README.md
├── README.en.md
├── CHANGELOG.md
├── LICENSE
├── package.json
├── .gitignore
└── .gitattributes
```

> The closure also contains `lib/session-file-name.mjs`: `attach-refs.mjs` takes its session-log
> filename judge from it. Without it, reconciliation goes blind when the host package renames the
> log (`session.vN.jsonl.zstd`).

---

## 3. Per-tool reference

### 3.1 `attachments-audit.mjs` — attachment reconciliation (read-only)

**What it answers**: a session with images, synced from another machine, fails on the next turn with
`DeepSeek API stream from … failed` / `code=TRANSPORT`. It looks like a network fault, but the image
objects (`<DSH_HOME>/attachments/v1/objects/<first2>/<sha256>`) are simply absent locally: every request
scans all historical messages for images, the missing object throws a plain Error, and the fallback
classifies it as TRANSPORT. This tool turns "which objects are missing / which sessions are affected"
into observable facts.

| Flag | Meaning |
|---|---|
| `--home <dir>` | Override DSH home (`BUTLER_DSH_HOME` → `DSH_HOME` → `~/.dsh`) |
| `--session <id\|prefix>` | Audit a single session |
| `--json` | Machine-readable output |
| `--quiet` | Exit code only (for boot / handoff hooks) |
| `--no-cache` | Full rescan, ignore cache |
| `--cache <file>` | Override cache file (default `<home>/butler-attach-scan.json`) |
| `--top <n>` | Max sessions listed in the summary (default 20) |
| `--sessions-only` | Sessions only, no per-object expansion |
| `--verify-objects` | Recompute sha256 for hits (slow; catches "present but wrong content") |

**Exit codes**: `0` no missing objects · `3` missing objects · `2` usage error · `4` environment
unavailable (cannot read sessions/attachments root). `4` is fail-closed: **unreadable ≠ nothing missing**.

**Read-only**: writes nothing except its own cache; the cache key includes relative path + size +
mtimeMs (mtime alone is fooled by copies).

### 3.2 `attachments-fetch.mjs` — fetch / export / rollback (writes)

**What it does**: materializes missing image objects by sha256 into
`<DSH_HOME>/attachments/v1/objects/<2>/<sha>`, using the exact layout DSH expects.
Source priority: `--from` → `--relay` / `DSH_ATTACH_RELAY` / common relay dirs → local derived
sources (`<home>/dsh-imagegen/{images,gallery/images}`, `<workspace>/generated`, matched by content sha).

| Flag | Meaning |
|---|---|
| `--hash <sha256>` | Fetch given objects (repeatable; comma-separated accepted) |
| `--session <id\|prefix>` | Fetch every missing object referenced by that session |
| `--all-missing` | Reconcile and fetch everything missing |
| `--probe` | List available sources and coverage (**pure read**) |
| `--export <dir>` | Export locally referenced attachments into a relay bundle |
| `--rollback <report.json>` | Delete files newly written by the run described in the report |
| `--from <path>` | Source root (repeatable; attachments root / v1 / objects / any dir, auto-detected) |
| `--relay <dir>` | Relay directory (repeatable) |
| `--local-source <dir>` | Extra local derived source (repeatable) |
| `--no-local-sources` | Skip local derived sources |
| `--home <dir>` | Override DSH home |
| `--verify` / `--no-verify` | Re-verify sha256 after placement (default on) |
| `--dry-run` | Print the plan, write nothing |
| `--force` | Overwrite when the target exists with different content (default: report conflict, no overwrite) |
| `--json` / `--report <file>` / `--quiet` | Output shape / write a report / exit code only |

**Exit codes**: `0` all placed · `3` some sources not found · `4` failures (write/verify) · `2` usage error.

**Write discipline**: write a temp file in the same directory → verify sha256 → atomic `rename` →
re-read and verify again. Existing object with matching sha ⇒ skip (idempotent). Content mismatch ⇒
conflict, **no overwrite** unless `--force`.

> **First run**: `--probe --dry-run`. It only lists sources and coverage; nothing is written.

### 3.3 `dsh-why.mjs` — read-only health check

**Answers in one command**: (1) which host is running (2) when dsh and the guard started
(**dsh main process = owner of the LISTEN socket on 3080**, never command-line matching)
(3) connections on port 3080 (4) guard state and log tail.

| Flag | Meaning |
|---|---|
| `--json` | Machine-readable (stdout only; logs never pollute it) |
| `--log-lines <n>` | Log tail lines (default 12; `0` disables) |
| `--procs-file <p>` | Offline process-table JSON instead of live CIM (self-test / negative fixtures / cross-host reproduction; output is labelled) |

**Read-only**: no hooks, no forced pipeline, **writes no files**.

**Output redaction**: this tool prints process command lines / environment / log tails (command
lines often contain keys/tokens) ⇒ output is redacted by key name or value shape
(`lib/redact.mjs`; display only, judging logic unchanged).

**Device short code**: host name is slugified by default (`DSH_DEVICE_LABEL` overrides); no machine
name is hard-coded.

### 3.4 `owner-todo-scan.mjs` — "owner action required" list (`--write` rewrites the file)

**Why**: a session title's "done" only means "this turn finished", not "the work is closed".
What truly waits for you lives in four places: board-card descriptions ("pending decision / waiting
for owner / waiting for you"), `docs\交接-*.md` handoffs, peer-machine run sheets, and the live DSH
upgrade lock (interrupted / undeterminable / phase=failed).

| Flag | Meaning |
|---|---|
| (none) | In-flight cards + handoff documents + peer run sheets |
| `--all` | Also scan done cards' historical "pending decision" sections (noisy; last resort) |
| `--write` | Write `docs\your-todo-<device>.md` (whole-file rewrite) |
| `--json` | Machine-readable (fullest detail: `cards[].hits/grades`, `handoffs[].verdict`) |

⚠️ **This tool has no help command; unknown arguments are silently ignored and the real action runs**
(with `--write`, that means a real file write).

**Grade split**: every item is graded `🔧self` / `🔴red-line` / `❔unknown` by autonomy keywords.
Self-grade items are **kept out of the Markdown body** (a count only), while `--json` keeps full detail.

**Output**: `your-todo-<device>.md` is stamped with a generated-document marker (`todo` family); the
insertion point comes from `lib/generated-docs.mjs` (`insertAtFor(firstH1Index(...))`) and the file is
rewritten as a whole.

### 3.5 Optional kernel dependency of `owner-todo-scan.mjs` (not a missing piece)

The judging implementations behind three sections — upgrade lock, guard-lane suppression, residue
reaping — are **not shipped in this repository**. They live in the DSH private tools tree
(`tools/dsh-butler/lib/`):

| Module | Purpose | When absent here |
|---|---|---|
| `upgrade-lock.mjs` | single source of truth for the upgrade lock `status()` | prints one line "upgrade lock: not probeable (unavailable ≠ no lock)" and continues |
| `lane-gate.mjs` | guard-lane suppression judge + wording | silently skipped (not an owner action; avoids noise) |
| `residue-reaper.mjs` | residue-reaping record judge + wording | silently skipped (same) |

**Why split this way**: this repository does not keep a second copy of those judges — duplicating
them is where calibration drift starts. The published version only changes the **static import into a
dynamic one**: with the kernel present, behaviour is byte-for-byte the same as the private tree;
without it, the fallbacks above apply. **No judging rule (which states need a human) was changed.**

To enable the real judges: point `DSH_TOOLS_DIR` at your tools tree (default `<workspace>/tools`), or
`DSH_BUTLER_LIB` directly at `dsh-butler/lib`.

---

## 4. Recommended sequence for the attachment pair

```powershell
# 1) Reconcile first (read-only): how many objects are missing and which sessions are affected
node attachments-audit.mjs --json > audit.json

# 2) Inspect sources (read-only): what sources exist and coverage
node attachments-fetch.mjs --probe

# 3) Preview (writes nothing): what it plans to place
node attachments-fetch.mjs --all-missing --dry-run --report plan.json

# 4) Fetch for real (writes; double verification on by default)
node attachments-fetch.mjs --all-missing --report fetch.json

# 5) Roll back from the report (deletes only files newly written by that run)
node attachments-fetch.mjs --rollback fetch.json
```

---

## 5. Security & privacy

- **No network**: none of the four tools makes HTTP requests.
- **No credentials**: they never touch `credentials.yaml`, tokens, or secret environment variables.
- **Local paths only**: `DSH_HOME`, `DSH_ROOT`, `docs` — writes are limited to §3.2 / §3.4.
- **Redaction**: secret-shaped strings in `dsh-why` output are redacted via `lib/redact.mjs`.
- What they scan is **your own** session logs and board ledger. Do not commit that data to a public repo.

---

## 6. License

Code is released under **AGPL-3.0 + commercial licensing** (dual licensing); see [LICENSE](LICENSE).
In short: **use/modify under AGPL-3.0 and keep derivatives open, or obtain a commercial license.**
(AGPL itself does not forbid commercial use; "+ commercial license" is dual licensing, not a non-commercial clause.)

---

## 7. Changelog

See [CHANGELOG.md](CHANGELOG.md). First public version: `v0.1.0` (2026-10-19).
