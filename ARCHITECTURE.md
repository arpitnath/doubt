# doubt: how it works

For agents and people reading this repo cold. What doubt is, how a PR moves through it, where every
piece of state lives, and what is deliberately not there. The user-facing tour is [GUIDE.md](GUIDE.md);
what was built when, with the steps used to verify it, is [PLAN.md](PLAN.md).

## 1. What it is, and the one rule

doubt is a local tool for reading pull requests that agents wrote. Agents produce code faster than
people read it; if agents also review it, nobody understands it. Slop is not code that is wrong, it is
code nobody understands. doubt makes it practical to refuse to approve what you have not understood.

**Approve means understood, not verified.** Every file gets one verdict, read or not. Correctness is
CI's and the tools' job; comprehension is the reader's. So:

- the agent answers when asked and never reads for you: nothing runs unasked, nothing marks a file
  read, nothing grades the PR;
- signals are facts ("touched by 3 commits"), never scores;
- nothing is posted to GitHub; approval and merge stay there.

Every design choice below protects that rule. A feature that makes "read" faster without a question
being asked is suspect by default.

## 2. Shape

```
browser (React, @pierre/diffs, xterm.js)
   │  HTTP JSON, one WebSocket per terminal
daemon (Node 22, one process, 127.0.0.1:7880)
   ├─ git.ts         checkout, merge-base, commits, diffs, grep, blame       → git
   ├─ github.ts      PR metadata, token                                      → gh
   ├─ state.ts       one JSON file per PR, the event log
   ├─ signals.ts     facts about each changed file
   ├─ lang.ts        TypeScript language service: definitions, references, hover
   ├─ term.ts        Claude Code in pseudo-terminals                         → claude (node-pty)
   ├─ transcript.ts  answers read from Claude Code's session transcripts      → ~/.claude/projects
   └─ server.ts      routes, PR lifecycle, startup checks
```

External programs do the real work: git computes diffs, gh talks to GitHub, the Claude Code CLI
answers, TypeScript understands code. The daemon is glue and state. No database, nothing beyond
localhost, one language. About 1,500 lines of daemon and 1,600 of UI.

## 3. Opening a PR

`POST /api/open` (from the landing page) or `doubt <pr-url>` (command line) both go through
`openForReview` → `openPr` in `server.ts`:

1. `gh api repos/<o>/<r>/pulls/<n>` for title, author, base and head, the clone URL and the body
   (`github.ts`). The token comes from `gh auth token`.
2. `checkout` (`git.ts`): a blob-filtered clone of the base repo at
   `~/.doubt/work/<owner>-<repo>-<n>` (one per PR), then
   `fetch +refs/pull/<n>/head:refs/doubt/pr +<base>:refs/doubt/base`, a detached checkout of the head,
   and `merge-base HEAD refs/doubt/base`. A merged PR's merge-base is its own head, so the base falls
   back to GitHub's `base.sha`. The previous head is kept at `refs/doubt/prev` for interdiffs. The
   token reaches git through `GIT_CONFIG_*` environment variables, never argv or the URL.
3. If saved state exists for the same head, it is resumed. Otherwise: commits oldest first
   (`--topo-order`), the files each commit touched (chunks), the PR-wide file list against the
   merge-base with blob pairs and whitespace-only detection, the full diff written to
   `<checkout>/.doubt/pr.diff` (excluded through `.git/info/exclude`), and signals.
4. **Read marks survive pushes**: a file read before keeps its mark if its blob pair (old, new) did not
   change (`carryOver`). `changedSince` records which files did, for the "new" badge and the
   since-your-read diff.
5. 2 s later, in the background, the language service for the first source file, the base versions of
   the changed files and the base project are built, so the first hover is fast.

`POST /api/sync` re-runs the same path with `force`: a new head rebuilds and carries marks over; an
unchanged head is a no-op.

## 4. Data and where it lives

| What | Where | Notes |
|---|---|---|
| PR state | `~/.doubt/state/<owner>-<repo>-<n>.json` | `PrState` in `state.ts`; written with write-then-rename |
| PR checkouts | `~/.doubt/work/<owner>-<repo>-<n>/` | one blob-filtered clone per PR; never cleaned up today |
| Event log | `~/.doubt/events.jsonl` | `open`, `view`, `verdict`, `doubt`, one JSON line each, local only |
| Theme | browser `localStorage` `doubt.theme` | `dark`, `dim`, `light` |
| Last Send to choice | `localStorage` `doubt.sendto.<pr-key>` | `term:<id>`, `session:<id>` or `new` |
| Answers seen | `localStorage` `doubt.seen.<pr-key>` | doubt ids; drives the tray's dot and "n new" |

`PrState` (see `daemon/state.ts` for the exact types):

- `commits`, and `chunks` = commit × file, each with a verdict `none | understood | doubt`. The chunk
  verdicts are the truth.
- `files`: the PR-wide list against the merge-base, with `oldBlob`, `newBlob`, `kind`
  (`src`, `test`, `docs`, `config`, `generated`, `snapshot`, `lock`) and `wsOnly`.
- `readFiles`: path → blob pair, recomputed from chunks on every save. A file is read when every
  chunk of it is read, from the Changes or the Commits tab.
- `prevHeadSha`, `changedSince`: what the last sync changed.
- `signals`: per file, from `signals.ts` (below).
- `doubts`: a question on a path and line range, the session it went to (`title`, `termCwd`,
  `sessionId`, `termStartedAt`), the `marker` used to find its answer, the `answer` text, `done`,
  `resolved`.

Reading order (`readingOrder` in `ui/src/api.ts`): source, tests, docs, config, snapshots, generated,
lockfiles; whitespace-only files after the rest of their kind. Noise (`isNoise`) is lockfiles,
generated files, snapshots and whitespace-only changes.

## 5. Daemon modules

- **`server.ts`**: the HTTP server, the open-PR registry (`Map` of key → state, tree paths, language
  service, base texts), startup checks (Node 22, git, a gh token; a warning if `claude` is missing),
  the transcript poll (every 1.5 s for doubts without an answer), the WebSocket upgrade, and routes.
  Every request passes `fromLocalPage`: the `Host` must be `127.0.0.1` or `localhost`, and a present
  `Origin` must be the page's own.
- **`git.ts`**: every operation is a `git` child process with a 10-minute ceiling and a 64 MB buffer:
  checkout, commits, per-commit and PR-wide diffs (merge commits via `show --remerge-diff`, so only
  conflict resolutions show), numstat with renames, `git grep`, `git blame` with PR numbers parsed from
  subjects, `ls-tree`, `show`.
- **`github.ts`**: `gh auth token` and `gh api`, 30 s timeouts.
- **`state.ts`**: load, save (recomputes `readFiles`), `carryOver`, `logEvent`.
- **`signals.ts`**: facts from the diff text and chunks: `rewritten` (touched by more than one commit),
  `tests` (net loss of test or assertion lines), `deps` (dependency lines added to a manifest),
  `todo`, `dup` (a 5-line block of added lines seen in two files of this PR), `sensitive` (a word in the
  path, plus `.doubt.json` `{ "sensitive": [...] }`), `owners` (CODEOWNERS, last match wins).
- **`lang.ts`**: code intelligence (section 7).
- **`term.ts`** and **`transcript.ts`**: the agent (section 6).

| Route | Does |
|---|---|
| `GET /api/prs` | every PR opened before, from state files and memory |
| `POST /api/open` | open a PR by URL |
| `GET /api/pr?pr=` | the PR's state |
| `POST /api/sync?pr=` | refetch the head |
| `GET /api/tree?pr=` | every path at the head |
| `GET /api/diff?pr=&path=[&since=1]` / `&chunk=` | a file's PR-wide diff, its interdiff since the previous head, or one commit's change to it |
| `GET /api/file?pr=&rev=&path=` | a file at `base`, `head` or a commit |
| `POST /api/verdict?pr=` | read or unread, by chunk, commit, path or paths |
| `GET /api/search?pr=&q=` | `git grep` at the head, capped at 500 |
| `GET /api/history?pr=&path=&start=&end=` | blame on the lines, grouped by commit |
| `GET /api/def`, `/api/refs`, `/api/hover` `?pr=&path=&line=&col=` | code intelligence |
| `GET /api/agent/sessions[?pr=]` | Claude Code sessions on the machine, grouped for that PR |
| `GET /api/agent/terms`, `POST /api/agent/open`, `/close` | terminals |
| `POST /api/agent/write` | type into a terminal; with a comment, record a doubt and deliver it |
| `POST /api/agent/resolve` | tick a doubt resolved |
| `WS /ws/term?id=` | a terminal's bytes both ways, plus a resize frame |

## 6. The agent

**Terminals.** `term.ts` runs the real Claude Code CLI in a pseudo-terminal (`node-pty`), streamed to
xterm.js in the page over a WebSocket, with the last 400 KB replayed on reconnect. Nothing of the CLI
is re-implemented. It starts through the user's login shell so `claude` resolves as in their terminal,
with arguments passed as `"$@"` so nothing from a request is parsed by the shell. The environment drops
`CLAUDECODE` and `CLAUDE_CODE_*` so a nested CLI starts.

**A PR checkout is untrusted code.** A Claude started inside `~/.doubt/work` gets
`--setting-sources user`: the PR's own `.claude/settings.json` (hooks, permissions) never configures
the reviewer. Sessions resumed in the user's own projects keep their project settings. The user's own
settings still apply, including a default permission mode (see section 10).

**Send to.** `GET /api/agent/sessions?pr=` labels each session by where it runs relative to the PR
(`relation` in `server.ts`): `this-pr` (the PR's checkout), `other-pr` (a folder named exactly
`<owner>-<repo>-<number>` under `~/.doubt/work`), `clone` (a folder whose git remote is the same
GitHub repo), or `other` (not offered). A session whose folder is gone is listed but cannot be picked.
The doubt box (`ui/src/SendTo.tsx`) says what each choice will see when it reads files.

**Delivery.** The daemon composes the message so the record and the text carry the same marker:

```
Review comment on <path>:<a>-<b> (PR #<n> <owner>/<repo>, head <sha7>) [doubt <id>]
```
followed by the selected code fenced, then the question. It goes in as a bracketed paste plus Enter.
A session that is still starting must not receive it yet: `writeTerm(..., whenReady)` queues it until
the CLI's input box shows (the last `❯` comes after the last mention of "trust") and the output has
been quiet for 400 ms. The folder-trust question is the user's to answer; text waits behind it.

**Answers.** Never parsed from the terminal stream. `transcript.ts` finds the session's JSONL under
`~/.claude/projects/<cwd with non-alphanumerics as ->/` (by session id, or the newest file created
after the terminal started), finds the user turn containing the marker, and collects the assistant
text after it. The answer is done at the CLI's `system`/`turn_duration` record, or at the next real
user turn. The UI shows it under the line it is about, in the Updates tray at the top of the agent
panel, and in the Doubts tab.

## 7. Code intelligence

`lang.ts` holds TypeScript 5's language service (the `ts5` package alias: the repo's own `typescript`
is the native 7.x, which has no JS API), one per PR, built lazily. TypeScript and JavaScript only.

- **Projects like an editor**: each file belongs to the nearest `tsconfig.json` or `jsconfig.json`
  above it and gets that project's options (aliases, `baseUrl`, `jsx`); files with none, or not
  included by their config, share a default project. Projects share one document registry.
- **Workspace packages** resolve by name in every project (absolute paths from each `package.json`).
  A project's own alias targets come first and the workspace source follows, so a mapping to an unbuilt
  `dist/` still resolves in a review checkout.
- **Hover** (`hover`): quick info (signature, doc), the first definition, the files referencing it
  (the server adds which of those this PR changes), `builtIn` when the definition is in TypeScript's
  lib files, and `lib` when the name is bound by an `import` or `require` of a package that does not
  resolve to a file in the checkout (its types are not installed; review checkouts have no
  `node_modules`).
- **Signature before**: a twin project reads the PR base's version of every modified file
  (`setBase`, fetched with the token since the clone is blob-filtered), finds the declaration with the
  same name through the syntax tree, and reports its signature when it differs from the head's.
- **In the UI**: the highlighter merges same-colored text into one token
  (`{ useState, useEffect }`), so `nameUnder` in `App.tsx` finds the name under the pointer from x
  (code is monospaced). Hover and click share it. Answers are cached per head and position.
- **Limits**: references through CommonJS `module.exports` properties are not found; plain JavaScript
  without JSDoc gives `any` for most types; other languages get search and the regex outline only.

`npm run check` (`daemon/lang.check.ts`) builds a tiny monorepo in a temp dir and asserts the
project, alias, `dist/` fallback, library and before-signature behaviour.

## 8. The UI

One React app (`ui/src`), Vite-built, served by the daemon:

- **`App.tsx`**: the review screen: top bar, sidebar tabs (Changes, Commits, Repo, Doubts), file bar,
  the diff (`@pierre/diffs` `PatchDiff` and `File`), the line bar (an annotation under the selected
  line), the inline doubt box, hover wiring, the five keys (`j k space u ⌘K esc`, `esc` closing).
- **`Tree.tsx`**: the file tree with status, counts, kind badges and signals.
- **`Palette.tsx`**: ⌘K: every action plus files (this PR's first), repo search, outline, lists of
  places.
- **`Agent.tsx`**: the agent panel, always mounted and hidden when closed, so terminals keep running;
  `deliver` resumes or starts a session and hands it the doubt; the Updates tray.
- **`SendTo.tsx`**, **`HoverCard.tsx`**, **`Landing.tsx`**, **`theme.ts`** (CSS variables on
  `<html data-theme>`, applied before the first paint), **`api.ts`** (the client, reading order, noise,
  fuzzy match, outline, hunk parsing).

The page polls `/api/pr` every 2 s only while a doubt is waiting for its answer.

## 9. Packaging

`npx @arpitnath/doubt` runs `dist/daemon/server.js` (the daemon compiled by `tsconfig.build.json`)
and serves the built `ui/dist`. Runtime dependencies are `node-pty`, `ws`, `ts5` and the Agent SDK
(used for `listSessions`); React, `@pierre/diffs`, xterm and `marked` are bundled into the UI. There
is no install script. node-pty's prebuilt `spawn-helper` arrives without its exec bit and npx installs
node-pty beside doubt, so `ensureSpawnHelper` in `term.ts` finds it through the module resolver and
fixes it before the first terminal. macOS and Windows get prebuilt node-pty binaries; Linux builds it.

## 10. Security model

- Localhost only, and only the daemon's own page: `Host` and `Origin` checked on every route and on
  the WebSocket upgrade.
- A PR checkout is someone else's code: its `.claude/` settings never load into the reviewer's Claude;
  diff and file content are data, never instructions.
- Shell-outs never interpolate request data: arguments are arrays, the terminal gets `"$@"`.
- Every git and gh call has a timeout.
- **Open**: the user's own settings decide the reviewer's permission mode. If they default to auto
  mode, the reviewer's Claude in a PR checkout runs with those permissions. Not decided yet.

## 11. Deliberately not here

- Posting to GitHub, approving, merging.
- AI summaries or grades of the PR; diagnostics (squiggles): without installed packages they would
  mostly be false, and CI already reports the real ones.
- Per-hunk read marks (removed: unused, and keyed by hunk index they broke on any push).
- Editing code in the review checkout; Electron.

## 12. Known limits

- One full clone per PR, never cleaned up. Fast open (worktrees from a shared or the user's own
  clone) and TTL cleanup are parked in PLAN.md.
- `signals.ts`: `sensitive` matches words in paths and `owners` often marks every file; `dup` compares
  the PR only with itself. A redesign (secret scanning, AST duplicate detection against the base) is
  parked.
- The event log is local; there is no shared measurement yet.
- PR 1829's saved state on the author's machine carries a simulated previous head
  (`0000000deadbeef`) from an early sync test; its "1 changed" badge is that, not a bug.

## 13. Working on it

```sh
npm install && npm run ui:build && npm start -- <pr-url>   # tsx, from source
npm run check                                              # language service check
npx tsc -p tsconfig.json --noEmit --noUnusedLocals         # typecheck everything
npm run build && npm pack                                  # what npm would publish
```

- The test PR used for every verification so far is
  `https://github.com/teambruno/bruno-enterprise-edition/pull/1829` (111 files, 17 commits); facts
  about it in PLAN.md were checked against the code by hand.
- Work lands as one PR per batch, one commit per slice, each with "how to verify" steps, after a
  self-review with the author's `/pr-review` lens (first principles, then shape, readability,
  correctness; verify before raising).
- Deliberate shortcuts carry a `ponytail:` comment naming their ceiling.
- When testing against real PRs, note `~/.doubt/events.jsonl` and the PR's state file first and put
  them back afterwards: they are the author's real review history.
