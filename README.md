# doubt

A reading tool for PRs at agent volume. Walk a PR one chunk at a time. Each chunk gets one of two verdicts: **understood** (settled, hidden) or **doubt** (a located question routed to a Claude session that already holds the whole PR). Approve means understood, not verified. Claude answers when asked; it never pre-grades.

Status: PoC. Works end to end on real PRs.

## Run

```sh
npx @arpitnath/doubt                   # opens http://127.0.0.1:7880, runs until you stop it
```

Paste a PR URL on the page. PRs you opened before are listed there with their progress; opening another PR never closes the first. `npx @arpitnath/doubt <pr-url>` opens one straight away. Add `--port 7881` if 7880 is taken, `--no-open` to skip opening the browser.

Needs Node 22 or newer, `git`, and the GitHub CLI logged in (`gh auth login`); doubt says so in one line at startup if one is missing. The agent panel also needs Claude Code on your PATH. On Linux, npm builds the terminal library (`node-pty`) from source during install, which needs a C++ toolchain; macOS and Windows get prebuilt binaries.

**From source**, to work on doubt itself:

```sh
npm install
npm run ui:build                       # once, and after UI changes
npm start                              # tsx, no compile step
npm run check                          # the language service check
```

`npm run build` compiles the daemon to `dist/` and builds the UI; `npm pack` runs it.

For each PR the daemon clones the base repo (blob-filtered) under `~/.doubt/work`, fetches the PR head, computes the merge-base and lists commits oldest first. State lives in `~/.doubt/state/<owner>-<repo>-<n>.json` and survives pushes for files whose content did not change.

## Reading

Everything is a visible control; the keyboard is a shortcut, not the way in.

The sidebar has four tabs. **Changes** is a GitHub-style tree of every file the PR changes against its merge-base, with status, counts, a kind badge (test, docs, cfg, lock, gen, snap) and `ws` when the change is whitespace only. Click a file to read its PR-wide diff; ‹ and › in the file bar (or `j`/`k`) walk the files in reading order: source first, then tests, then docs and config, then generated files and lockfiles. **Commits** lists commits oldest first; click one to see every file it touched stacked, or a file under it for that file alone. **Repo** is the whole tree at the PR head, folded except where the changes live; any file opens read-only for context. **Doubts** lists every doubt you asked.

Lockfiles, generated files, snapshots and whitespace-only changes are noise: when there is any, **Skip noise** above the tree marks it all read.

The file bar switches **Unified / Split** and **Changes / Whole file** (the whole file with the changes inline, like Zed), and **Mark read** settles the file or commit and opens the next unread one; click it again to unmark. A file is read when every commit's change to it is read, in either tab. Read marks are keyed by the file's content, so after the author pushes again only the files that actually changed come back as unread. **Sync** in the top bar refetches the head on demand and badges what changed; for such a file, **Since your read** shows only what changed since then. **Description** shows the PR body above the diff. The theme (dark, dim, light) sits at the end of the top bar.

**Line actions.** Click a line, or the `+` that appears in its gutter, and a bar opens under it: **Ask a doubt**, **Go to definition** and **Who uses** (of the name you clicked in that line), **Who touched this** (the commits and PR numbers that last changed those lines), **Copy ref** (`path:line`) and **Copy with code** (a fenced snippet with context). Drag over line numbers for a range. `⌘`-click a name goes to its definition and `⌘⌥`-click lists its references, as shortcuts.

**⌘K** opens one palette for everything: every action on the screen, and as you type, files in the whole repo with this PR's files first. Searching the repo (git grep) and the outline of the file in focus are entries in it.

| key | does |
|---|---|
| `j` / `k` | next / previous file (reading order) or commit |
| `space` / `⇧space` | next / previous change |
| `u` | mark read, open the next unread |
| `⌘K` | open, search, any action |
| `esc` | close what is open, clear the selection |

**Hover.** Hover a name in the code for what TypeScript knows about it: its signature and doc, where it is defined (click to open), how many files use it and which of them this PR also changes, that it comes from a package whose types are not installed in the checkout, or that it is built into JavaScript. When this PR changed its signature, the card shows it before and after. Each file uses the project of the nearest `tsconfig.json` or `jsconfig.json` above it, so aliases resolve as in an editor. TypeScript and JavaScript only; the language service builds in the background once a PR opens.

## Claude Code in the page

**Agent** in the top bar opens the agent panel: your Claude Code sessions as real terminals, the same CLI you run in a shell, with every prompt and slash command intact. Several can be open as tabs; they keep running while the panel is hidden, and survive page reloads while the daemon runs.

**Doubts to the agent.** Ask a doubt on a line, write, and pick where it goes in **Send to**: a session already open here, a session that worked in this PR's checkout, one in another PR's checkout, one in your own clone of the repo, or a new session in this PR's checkout. Each choice says what that session will see when it reads files. The choice is remembered per PR. Send (or `⌘enter`) starts or resumes the session in the panel and hands it a message carrying the file, the lines, the PR and head SHA, and the code; a session that is still starting gets it once its input is ready. The answer is read back from the session's transcript on disk, never from the terminal stream, and shown under the lines it is about. The **Updates** tray at the top of the panel lists every doubt with its status and session; an answer that arrived while you were reading another file gets a dot and **Agent** shows how many are new. Click one to go to its line. In the **Doubts** tab each can be ticked resolved once you understand.

**Signals, never grades.** Small markers in the tree for facts worth a look first: a file rewritten by more than one commit in the PR (↻), test or assertion lines removed (−t), dependency lines added (+dep), TODO or FIXME added, the same block added in two places (=), a sensitive path (!), and the CODEOWNERS area in the file bar. A `.doubt.json` in the repo with `{ "sensitive": [...] }` extends the sensitive list.

The terminals are a cloud-shell architecture: a pseudo-terminal on the daemon (`node-pty`), `xterm.js` in the browser, a WebSocket between. Nothing of the CLI is re-implemented. The nested session gets a clean environment so it never thinks it is running inside another Claude Code.

A PR checkout is someone else's code, so a Claude started there loads only your user settings: the PR's own `.claude/settings.json` (hooks, permissions) never configures your reviewer. Sessions resumed in your own projects keep their project settings. The daemon only answers its own page: requests from another site's page are refused.

What you do in the tool (PRs opened, files viewed, verdicts, doubts sent) is appended to `~/.doubt/events.jsonl`, on your machine only, so reading can be measured later.

## Layout

```
daemon/   server.ts git.ts github.ts state.ts term.ts transcript.ts signals.ts lang.ts   (Node, tsx)
ui/       Vite + React + @pierre/diffs: App, Tree, Palette, Agent, HoverCard
spike/    the first-hour risk check, kept as a record
```

Checkout and git flags follow px0 (MIT, github.com/px0-ai/px0). Diff rendering is @pierre/diffs (Apache-2.0).

## Not in the PoC

The room (teammates and their Claudes), posting to GitHub, semantic chunking, full-file view, Electron.
