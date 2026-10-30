# doubt: what it does and how to review with it

A reading tool for pull requests at agent volume. You walk a PR one piece at a time and say, for each piece, whether you understood it. Nothing leaves your machine.

## 1. Features

**Opening PRs**

- One daemon, started once with `npm start`, opens `http://127.0.0.1:7880`.
- Paste any GitHub PR URL on the landing page. Every PR you opened before is listed with title, author, read progress and whether it is open now. Click to return to it.
- PRs stay open side by side. Each review has a stable URL, `#/pr/<owner>-<repo>-<number>`.
- The daemon clones the base repo once per repo, blob-filtered, under `~/.doubt/work`, fetches the PR head, computes the merge-base, and lists commits oldest first. Merged PRs work too; the base falls back to the commit GitHub compared against.
- A private repo needs nothing extra beyond `gh auth login`.

**Four tabs in the sidebar**

- **Changes**: a GitHub-style tree of every file the PR touches against its merge-base. Single-child folders collapse into one row, folders fold, each folder shows how many files are still unread. Files carry a status letter, add and delete counts, a kind badge (test, docs, cfg, lock, gen, snap) and `ws` when the change is whitespace only.
- **Commits**: commits oldest first with their files. Click a commit to see every file it touched stacked in the center, or one file at a time.
- **Repo**: the whole repository at the PR head, like an editor's explorer, folded except where the changes live. Any file opens read-only for context.
- **Doubts**: every doubt you asked, with its answer, ticked resolved once understood.

**Reading**

- Every action is a visible control: the top bar has Description, Sync, Agent, ⌘K and the theme (dark, dim, light); the file bar has ‹ ›, Unified/Split, Changes/Whole file and Mark read.
- Split or unified diff, changed words highlighted inside changed lines.
- Collapsed context expands to the full file. Or **Whole file** shows the file with the changes inline, Zed-style.
- Reading order under ‹ › (or `j` and `k`): source first, then tests, then docs and config, then generated files and lockfiles. The tree stays in path order for orientation.
- Noise detection: lockfiles, generated output, snapshots and whitespace-only changes are cleared with **Skip noise** above the tree.

**Reading inside a file**

- Space and Shift+Space jump change to change.
- Click a line, or the `+` in its gutter, for its actions: Ask a doubt, Go to definition and Who uses (of the name you clicked), Who touched this (the commits that last changed the lines, with PR numbers and authors), Copy ref, Copy with code.
- Hover a name for its signature and doc, where it is defined, how many files use it and which of them this PR changes, and, when this PR changed its signature, before and after. A package whose types are not installed, or a JavaScript built-in, says so.
- **Description** shows the PR description above the diff, for checking claims against code.
- Signals under the file bar and in the tree, facts not grades: rewritten by several commits in this PR, tests or assertions removed, dependencies added, TODO added, same block added twice, sensitive path, CODEOWNERS area.

**Keeping up with pushes**

- **Sync** refetches the head on demand, keeps read marks for files whose content did not change, badges the changed ones `new`, and **Since your read** shows only what changed since the previous head for such a file.

**Verdicts and memory**

- Mark a file or a whole commit read, or unmark it. A file counts as read when every commit's change to it is read, from either tab.
- Read marks are keyed by the file's content, so after the author pushes again only files whose content actually changed come back as unread. Everything is in `~/.doubt/state/<owner>-<repo>-<number>.json`.

**Finding things**

- ⌘K: every action on the screen, and as you type, any file in the repo with this PR's files first.
- From ⌘K, search the whole repo at the PR head with git grep, as you type, case-insensitive. Enter lands on the line.
- From ⌘K, the outline of the file in focus: functions, classes, arrow functions, interfaces, types, enums, methods, describe and it blocks; Python, Go, Rust, Markdown headings and YAML keys too. Enter jumps.
- Go to definition and find references for TypeScript and JavaScript, from the line bar or with `⌘`-click and `⌘⌥`-click. Each file uses the nearest `tsconfig.json` or `jsconfig.json`, so aliases resolve as in an editor; workspace packages resolve by name.
- The browser's own Cmd+F works inside the diff.

**Taking things out**

- **Copy ref** copies `path:line-line` of the selected lines, **Copy with code** a fenced snippet with three lines of context, for pasting into a terminal, a comment or an agent.

**Claude Code in the page**

- **Agent** opens the agent panel: Claude Code sessions as real terminals inside the page, the same CLI as in a shell, nothing re-implemented. Several run as tabs, keep running while the panel is hidden, and survive page reloads.
- Doubts to the agent: Ask a doubt on a line, write, pick where it goes in **Send to** (a session open here, one that worked in this PR's checkout, another PR's checkout, your own clone, or a new session in this PR's checkout; each says what it will see), and send. The session starts or resumes and gets the file, line range, PR, head SHA and the code once its input is ready. The answer is read from the session's transcript and shown under those lines, in the Updates tray at the top of the panel (a dot for answers that arrived while you were elsewhere), and in the Doubts tab.

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

Paste a PR URL, or click one you opened before. First time on a repo takes 20 to 40 seconds, later opens a few. If 7880 is taken, `npm start -- --port 7881`.

**Keys, for speed; everything also has a button**

| key | does |
|---|---|
| `j` / `k` | next / previous file in reading order, or next commit |
| `space` / `⇧space` | next / previous change |
| `u` | mark read, open the next unread |
| `⌘K` | open, search, any action |
| `esc` | close what is open, clear the selection |
| `⌘` click / `⌘⌥` click | go to definition / list references of a name |

Click the page once so it has keyboard focus. Drag over line numbers to select a range.

**What the screen shows**

- Top bar: PR, repo, author, base and head, files read out of total as a bar, then Description, Sync, Agent, ⌘K and the theme.
- Left: the sidebar tab you chose.
- Center: one file against the merge-base, one commit stacked, one file of a commit, or a repo file read-only. The file bar above it says which and holds the view switches and Mark read.
- Right, when shown: the agent panel, with Updates above the terminals.

## 3. The flow that makes it fast

The tool is built around one rule: approve means understood, not verified. Correctness you can check with tests and tools. Comprehension is the one thing only you can do, and it is the thing that stops slop.

**Pass 1, the shape, two minutes.** Changes tab. Do not read diffs yet. Look at the tree: which packages, which folders, how many files are source versus tests versus config. **Skip noise** clears the noise. Open the one or two files with the biggest change in source and skim the header line of each hunk only. You now know what this PR is and where its boundary is. This is where first principles questions get asked: does this need to exist, is there already one of these, is the shape right.

**Pass 2, read in order.** Start on the first unread source file and let › (or `j`) carry you. Source first, so you see the behaviour change before the tests that encode it. For each file: read, then **Mark read** (or `u`). If you do not get it, do not mark it. Switch to **Whole file**, hover the thing you do not get, click it and use **Go to definition** or **Who uses**, or search for the string from ⌘K. Then mark it read, or leave it unread and move on. Unread files are the list of what you still do not understand. That list is the review.

**Pass 3, commits, when the author committed in steps.** Commits tab. Walk commits with ‹ › (or `j` and `k`), each one stacked. This is how to read a PR that tells a story, and how to read a sync PR where each commit is an upstream change already reviewed and only the hand fixes and the merge commit need eyes. A merge commit shows only its conflict-resolution lines.

**When a push arrives.** Press **Sync**. Files whose content did not change stay read, the changed ones get a `new` badge, and **Since your read** shows only what changed in each. The unread set is exactly what is new. Read those, done.

**Taking a doubt to the agent.** Click the line, **Ask a doubt**, write what you do not get, pick the session in **Send to** (one that already knows this PR, or a new one in the PR checkout), and send. The question arrives in that session with the file, the lines and the code, and the answer streams in the terminal beside the diff. Keep reading while it works: the answer lands under the line, and if you are elsewhere by then, Updates gets a dot. For a dev instead of an agent, **Copy with code** copies the same snippet for a GitHub comment.

**What to skip without guilt.** Everything **Skip noise** clears. Anything in the Repo tab you opened only for context. Tests until the source they test is understood.

**What not to do.** Do not mark a file read because the diff looks plausible. Plausible is what agents produce. Mark it read because you could explain the change to the author.

## Pointers

- How it works inside: [ARCHITECTURE.md](ARCHITECTURE.md)
- Code: daemon in `daemon/`, UI in `ui/src/`, the SDK risk spike in `spike/`
- State, clones and the event log: `~/.doubt/state`, `~/.doubt/work`, `~/.doubt/events.jsonl`
