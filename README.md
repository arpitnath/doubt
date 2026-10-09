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

The daemon clones the base repo (blob-filtered) under `~/.doubt/work`, fetches the PR head, computes the merge-base, lists commits oldest first, and opens the UI on `http://127.0.0.1:7880`. State lives in `~/.doubt/state/<owner>-<repo>-<n>-<sha7>.json`; a force-push starts a clean queue.

## Keys

| key | does |
|---|---|
| `u` | this chunk is understood; hide it, show the next unjudged one |
| `d` | open the doubt box for this chunk (select lines in the diff first to anchor it) |
| `j` / `k` | move without judging |
| `enter` / `esc` | send / cancel in the doubt box |

## Claude session

On first open the right pane lists Claude Code sessions that mention this repo in their working directory. Pick one and the PR session is a **fork** of it (its knowledge, none of its risk: the original is never written to), or start fresh. The first message asks for the PR's shape. Every doubt resumes that one session, in plan mode, with the PR worktree as its working directory.

## Layout

```
daemon/   git.ts github.ts state.ts agent.ts server.ts   (Node, tsx)
ui/       Vite + React + @pierre/diffs
spike/    the first-hour risk check, kept as a record
```

Checkout and git flags follow px0 (MIT, github.com/px0-ai/px0). Diff rendering is @pierre/diffs (Apache-2.0).

## Not in the PoC

The room (teammates and their Claudes), posting to GitHub, semantic chunking, full-file view, Electron.
