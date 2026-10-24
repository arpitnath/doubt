# doubt

A reading tool for PRs at agent volume. Walk a PR one chunk at a time. Each chunk gets one of two verdicts: **understood** (settled, hidden) or **doubt** (a located question routed to a Claude session that already holds the whole PR). Approve means understood, not verified. Claude answers when asked; it never pre-grades.

Status: PoC. Works end to end on real PRs.

## Run

```sh
npm install
npm run ui:build                       # once, and after UI changes
npm start                              # opens http://127.0.0.1:7880, runs until you stop it
```

Paste a PR URL on the page. PRs you opened before are listed there with their progress; opening another PR never closes the first. `npm start -- <pr-url>` opens one straight away. Add `-- --port 7881` if 7880 is taken.

Needs `git`, `gh` (logged in), Node 22. The Claude binary ships with the Agent SDK.

For each PR the daemon clones the base repo (blob-filtered) under `~/.doubt/work`, fetches the PR head, computes the merge-base and lists commits oldest first. State lives in `~/.doubt/state/<owner>-<repo>-<n>.json` and survives pushes for files whose content did not change.

## Reading

The sidebar has three tabs, `s` cycles. **Changes** is a GitHub-style tree of every file the PR changes against its merge-base, with status, counts, a kind badge (test, docs, cfg, lock, gen, snap) and `ws` when the change is whitespace only. Click a file to read its PR-wide diff; `j`/`k` walk the files in reading order: source first, then tests, then docs and config, then generated files and lockfiles. **Commits** lists commits oldest first; click one to see every file it touched stacked, `c` drops to one file. **Repo** is the whole tree at the PR head, like an editor's explorer, folded except where the changes live; any file opens read-only for context. `p` opens any file by fuzzy name.

Lockfiles, generated files, snapshots and whitespace-only changes are noise: the top bar counts them and `n` marks them all read in one go.

A file is read when every commit's change to it is read, in either tab. Read marks are keyed by the file's content, so after the author pushes again only the files that actually changed come back as unread.

Select lines by clicking line numbers; that selection is what `y`, `Y` and the outline use as the file in focus. Changed lines highlight the changed words. Collapsed context expands to the full file, or `e` shows the whole file with the hunks inline, like Zed; `w` switches split and unified. Click the page once after it opens so it has keyboard focus.

| key | does |
|---|---|
| `u` | read: settle the shown file or commit, show the next unread one |
| `x` | unmark it |
| `n` | mark every noise file read |
| `j` / `k` | next / previous file (reading order) or commit |
| `s` | cycle Changes, Commits, Repo |
| `p` | open any file by fuzzy name |
| `g` | search the repo (git grep, case-insensitive), Enter lands on the line |
| `o` | outline of the file in focus: functions, classes, types, tests; Enter jumps |
| `y` / `Y` | copy `path:line` for the selected lines, or a fenced snippet with context |
| `⌘`click | go to definition of a token; `⌘⌥`click lists its references (TypeScript and JavaScript, built on first use) |
| `a` | open or hide the agent sidebar |
| `d` | review comment on the selected lines, sent to the active session with `⌘enter`; the answer comes back under those lines and in the Doubts tab |
| `space` / `⇧space` | next / previous hunk |
| `m` | mark the current hunk read; a fully marked file becomes read |
| `b` | who last touched the selected lines, with PR numbers |
| `r` | sync: refetch the head on demand, keep marks for untouched files, badge what changed |
| `i` | for a file that changed since your read: only what changed, or the whole diff |
| `v` | show or hide the PR description |
| `?` | every key, on screen |
| `e` | whole file with inline hunks, or hunks only |
| `w` | split or unified |
| `c` | in Commits: whole commit or one file |
| `[` / `]` | in a stacked commit: jump between files |

## Claude Code in the page

`a` opens the agent sidebar. It lists your Claude Code sessions from every project, with summary, directory, branch and last activity. Click one and that session resumes in a real terminal inside the page, the same CLI you run in a shell, with every prompt and slash command intact. Or start a new session in the PR checkout. Several can be open as tabs; they survive page reloads while the daemon runs.

**Review comments to the agent.** Select lines in any file, press `d`, write, `⌘enter`. The comment lands in the active session as a message carrying the file, the line range, the PR and head SHA, and the selected code. GitHub's gesture, with the agent as the recipient. The answer is read back from the session's transcript on disk, never from the terminal stream, and shown under the lines it is about and in the **Doubts** tab, where each doubt can be ticked resolved once you understand.

**Signals, never grades.** Small markers in the tree for facts worth a look first: a file rewritten by more than one commit in the PR (↻), test or assertion lines removed (−t), dependency lines added (+dep), TODO or FIXME added, the same block added in two places (=), a sensitive path (!), and the CODEOWNERS area in the file bar. A `.doubt.json` in the repo with `{ "sensitive": [...] }` extends the sensitive list.

It is a cloud-shell architecture: a pseudo-terminal on the daemon (`node-pty`), `xterm.js` in the browser, a WebSocket between. Nothing of the CLI is re-implemented. The nested session gets a clean environment so it never thinks it is running inside another Claude Code.

A PR checkout is someone else's code, so a Claude started there loads only your user settings: the PR's own `.claude/settings.json` (hooks, permissions) never configures your reviewer. Sessions resumed in your own projects keep their project settings. The daemon only answers its own page: requests from another site's page are refused.

What you do in the tool (PRs opened, files viewed, verdicts, doubts sent) is appended to `~/.doubt/events.jsonl`, on your machine only, so reading can be measured later.

## Layout

```
daemon/   server.ts git.ts github.ts state.ts term.ts transcript.ts signals.ts lang.ts   (Node, tsx)
ui/       Vite + React + @pierre/diffs
spike/    the first-hour risk check, kept as a record
```

Checkout and git flags follow px0 (MIT, github.com/px0-ai/px0). Diff rendering is @pierre/diffs (Apache-2.0).

## Not in the PoC

The room (teammates and their Claudes), posting to GitHub, semantic chunking, full-file view, Electron.
