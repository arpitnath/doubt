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

The center shows either one commit with every file it touched stacked (click a commit in the queue, or `c`), or one file (click a file, or `c` again). Keys act on what is shown. Click the page once after it opens so it has keyboard focus.

| key | does |
|---|---|
| `u` | read: settle the shown file or the whole commit, show the next unread one |
| `x` | unmark the shown file or commit |
| `c` | switch between whole-commit and single-file view |
| `j` / `k` | move to the next or previous commit or file without judging |

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
