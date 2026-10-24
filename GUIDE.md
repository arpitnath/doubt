# doubt: what it does and how to review with it

A reading tool for pull requests at agent volume. You walk a PR one piece at a time and say, for each piece, whether you understood it. Nothing leaves your machine.

## 1. Features

**Opening PRs**

- One daemon, started once with `npm start`, opens `http://127.0.0.1:7880`.
- Paste any GitHub PR URL on the landing page. Every PR you opened before is listed with title, author, read progress and whether it is open now. Click to return to it.
- PRs stay open side by side. Each review has a stable URL, `#/pr/<owner>-<repo>-<number>`.
- The daemon clones the base repo once per repo, blob-filtered, under `~/.doubt/work`, fetches the PR head, computes the merge-base, and lists commits oldest first. Merged PRs work too; the base falls back to the commit GitHub compared against.
- A private repo needs nothing extra beyond `gh auth login`.

**Three ways to cut the PR, in the sidebar**

- **Changes**: a GitHub-style tree of every file the PR touches against its merge-base. Single-child folders collapse into one row, folders fold, each folder shows how many files are still unread. Files carry a status letter, add and delete counts, a kind badge (test, docs, cfg, lock, gen, snap) and `ws` when the change is whitespace only.
- **Commits**: commits oldest first with their files. Click a commit to see every file it touched stacked in the center, or one file at a time.
- **Repo**: the whole repository at the PR head, like an editor's explorer, folded except where the changes live. Any file opens read-only for context.

**Reading**

- Split or unified diff, changed words highlighted inside changed lines.
- Collapsed context expands to the full file. Or show the whole file with the hunks inline, Zed-style.
- Reading order under `j` and `k`: source first, then tests, then docs and config, then generated files and lockfiles. The tree stays in path order for orientation.
- Noise detection: lockfiles, generated output, snapshots and whitespace-only changes are counted in the top bar and cleared with one key.

**Reading inside a file**

- Space and Shift+Space jump hunk to hunk. `m` marks the current hunk read; when every hunk of a file is marked, the file is read.
- `b` on selected lines: the commits that last touched them, with PR numbers and authors.
- `v` shows the PR description above the diff, for checking claims against code.
- Signals in the tree, facts not grades: rewritten by several commits in this PR, tests or assertions removed, dependencies added, TODO added, same block added twice, sensitive path, CODEOWNERS area in the bar.

**Keeping up with pushes**

- `r` syncs on demand: refetches the head, keeps read marks for files whose content did not change, badges the changed ones `new`, and `i` shows only what changed since the previous head for such a file.

**Verdicts and memory**

- Mark a file or a whole commit read, or unmark it. A file counts as read when every commit's change to it is read, from either tab.
- Read marks are keyed by the file's content, so after the author pushes again only files whose content actually changed come back as unread. Everything is in `~/.doubt/state/<owner>-<repo>-<number>.json`.

**Finding things**

- Fuzzy open any file in the repo by name.
- Search the whole repo at the PR head with git grep, as you type, case-insensitive. Enter lands on the line.
- Outline of the file in focus: functions, classes, arrow functions, interfaces, types, enums, methods, describe and it blocks; Python, Go, Rust, Markdown headings and YAML keys too. Enter jumps.
- Go to definition and find references for TypeScript and JavaScript through a language service built on first use. Workspace packages in a monorepo resolve by name.
- The browser's own Cmd+F works inside the diff.

**Taking things out**

- Copy `path:line-line` of the selected lines, or a fenced snippet with three lines of context, for pasting into a terminal, a comment or an agent.

**Claude Code in the page**

- `a` opens the agent sidebar: every Claude Code session on the machine, with summary, directory, branch and last activity. Click one and it resumes in a real terminal inside the page, the same CLI as in a shell, nothing re-implemented. Or start a new session in the PR checkout. Several run as tabs and survive page reloads.
- Review comments to the agent: select lines, `d`, write, `⌘enter`. The comment lands in the active session with the file, line range, PR, head SHA and the selected code. The answer is read from the session's transcript and shown under those lines and in the Doubts tab, where a doubt is ticked resolved once understood.

**Not in the tool, on purpose**

- Nothing is posted to GitHub. CI, merge and the formal approval stay there.
- The agent never reads for you: nothing runs unasked, nothing marks a file read, nothing grades the PR.

## 2. How to use it

**Setup, once**

```sh
cd doubt
npm install
npm run ui:build
```

Needs `git`, `gh` logged in, Node 22. Rebuild the UI after pulling changes to `ui/`.

**Every day**

```sh
npm start            # leave it running
```

Paste a PR URL, or click one you opened before. First time on a repo takes 20 to 40 seconds, later opens a few. Click the page once so it has keyboard focus. If 7880 is taken, `npm start -- --port 7881`.

**Keys**

| key | does |
|---|---|
| `u` | read: settle the shown file or commit, show the next unread one |
| `x` | unmark it |
| `n` | mark every noise file read |
| `j` / `k` | next / previous file in reading order, or next commit |
| `s` | cycle the sidebar: Changes, Commits, Repo, Doubts |
| `c` | in Commits: whole commit or one file |
| `[` / `]` | in a stacked commit: jump between files |
| `e` | whole file with inline hunks, or hunks only |
| `w` | split or unified |
| `p` | open any file by fuzzy name |
| `g` | search the repo; Enter lands on the line |
| `o` | outline of the file in focus; Enter jumps |
| `y` / `Y` | copy `path:line` for the selected lines, or a fenced snippet with context |
| `⌘` click | go to definition of a token |
| `⌘⌥` click | list references of a token |
| `a` | open or hide the agent sidebar |
| `d` | review comment on the selected lines; `⌘enter` sends it to the active session; the answer lands under the lines and in Doubts |
| `space` / `⇧space` | next / previous hunk |
| `m` | mark the current hunk read |
| `b` | history of the selected lines |
| `r` | sync the head on demand |
| `i` | only what changed since the previous head, for a changed file |
| `v` | PR description on or off |
| `?` | every key, on screen |
| `Esc` | close any palette |

Select lines by clicking a line number and dragging. That selection is what `y`, `Y` and the outline treat as the file in focus; in a stacked commit it also picks which file they mean.

**What the screen shows**

- Top bar: PR, repo, author, base and head, and files read out of total with the noise count.
- Left: the sidebar tab you chose.
- Center: one file against the merge-base, one commit stacked, one file of a commit, or a repo file read-only. The header line says which.
- Palettes open over the center for open, search, outline and references.

## 3. The flow that makes it fast

The tool is built around one rule: approve means understood, not verified. Correctness you can check with tests and tools. Comprehension is the one thing only you can do, and it is the thing that stops slop.

**Pass 1, the shape, two minutes.** Changes tab. Do not read diffs yet. Look at the tree: which packages, which folders, how many files are source versus tests versus config. Press `n` to clear the noise. Open the one or two files with the biggest change in source and skim the header line of each hunk only. You now know what this PR is and where its boundary is. This is where first principles questions get asked: does this need to exist, is there already one of these, is the shape right.

**Pass 2, read in order.** Start on the first unread source file and let `j` carry you. Source first, so you see the behaviour change before the tests that encode it. For each file: read, then `u`. If you do not get it, do not press `u`. Press `e` for the whole file, `⌘`click the thing you do not get, `⌘⌥`click to see who else calls it, `g` to find the string. Then `u`, or leave it unread and `j` on. Unread files are the list of what you still do not understand. That list is the review.

**Pass 3, commits, when the author committed in steps.** Commits tab. Walk commits with `j` and `k`, each one stacked. This is how to read a PR that tells a story, and how to read a sync PR where each commit is an upstream change already reviewed and only the hand fixes and the merge commit need eyes. A merge commit shows only its conflict-resolution lines.

**When a push arrives.** Press `r`. Files whose content did not change stay read, the changed ones get a `new` badge, and `i` shows only what changed in each. The unread set is exactly what is new. Read those, done.

**Taking a doubt to the agent.** Press `a`, open the session that knows this repo, or a new one in the PR checkout. Then select the lines, `d`, write what you do not get, `⌘enter`. The question arrives in that session with the file, the lines and the code, and the answer streams in the terminal beside the diff. Keep reading while it works. For a dev instead of an agent, `Y` copies the same snippet for a GitHub comment.

**What to skip without guilt.** Everything `n` clears. Anything in the Repo tab you opened only for context. Tests until the source they test is understood.

**What not to do.** Do not press `u` because the diff looks plausible. Plausible is what agents produce. Press `u` because you could explain the change to the author.

## Pointers

- Code: daemon in `daemon/`, UI in `ui/src/`, the SDK risk spike in `spike/`
- State, clones and the event log: `~/.doubt/state`, `~/.doubt/work`, `~/.doubt/events.jsonl`
