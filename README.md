# doubt

A reading tool for PRs at agent volume. Walk a PR one chunk at a time. Each chunk gets one of two verdicts: **understood** (settled, hidden) or **doubt** (a located question routed to a Claude session that already holds the whole PR). Approve means understood, not verified. Claude answers when asked; it never pre-grades.

Status: PoC. Works end to end on real PRs. Design and decisions: `~/Desktop/refs/doubt-poc.md`.

## Run

```sh
npm install
npm run ui:build                       # once, and after UI changes
npm start -- https://github.com/<owner>/<repo>/pull/<n>
```

Needs `git`, `gh` (logged in), Node 22. The Claude binary ships with the Agent SDK.

The daemon clones the base repo (blob-filtered) under `~/.doubt/work`, fetches the PR head, computes the merge-base, lists commits oldest first, and opens the UI on `http://127.0.0.1:7880`. State lives in `~/.doubt/state/<owner>-<repo>-<n>.json` and survives pushes for files whose content did not change.

## Reading

The sidebar has three tabs, `s` cycles. **Changes** is a GitHub-style tree of every file the PR changes against its merge-base, with status, counts, a kind badge (test, docs, cfg, lock, gen, snap) and `ws` when the change is whitespace only. Click a file to read its PR-wide diff; `j`/`k` walk the files in reading order: source first, then tests, then docs and config, then generated files and lockfiles. **Commits** lists commits oldest first; click one to see every file it touched stacked, `c` drops to one file. **Repo** is the whole tree at the PR head, like an editor's explorer, folded except where the changes live; any file opens read-only for context. `p` opens any file by fuzzy name.

Lockfiles, generated files, snapshots and whitespace-only changes are noise: the top bar counts them and `n` marks them all read in one go.

A file is read when every commit's change to it is read, in either tab. Read marks are keyed by the file's content, so after the author pushes again only the files that actually changed come back as unread.

Changed lines highlight the changed words. Collapsed context expands to the full file, or `e` shows the whole file with the hunks inline, like Zed; `w` switches split and unified. Click the page once after it opens so it has keyboard focus.

| key | does |
|---|---|
| `u` | read: settle the shown file or commit, show the next unread one |
| `x` | unmark it |
| `n` | mark every noise file read |
| `j` / `k` | next / previous file (reading order) or commit |
| `s` | cycle Changes, Commits, Repo |
| `p` | open any file by fuzzy name |
| `e` | whole file with inline hunks, or hunks only |
| `w` | split or unified |
| `c` | in Commits: whole commit or one file |
| `[` / `]` | in a stacked commit: jump between files |

## Claude session

Out of the UI for now. The daemon still serves `/api/sessions`, `/api/session` (fork or fresh, returns the PR's shape) and `/api/doubt` (a question or a `take` on a file or commit), all streaming over SSE, so the room can come back when the session flow is right.

## Layout

```
daemon/   git.ts github.ts state.ts agent.ts server.ts   (Node, tsx)
ui/       Vite + React + @pierre/diffs
spike/    the first-hour risk check, kept as a record
```

Checkout and git flags follow px0 (MIT, github.com/px0-ai/px0). Diff rendering is @pierre/diffs (Apache-2.0).

## Not in the PoC

The room (teammates and their Claudes), posting to GitHub, semantic chunking, full-file view, Electron.
