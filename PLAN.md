# Plan: review screen v2, doubt → agent, code intelligence

Built from the design canvas (review screen, agent panel, hover prototype). Every slice is one PR on
`arpitnath/doubt`, and every slice ends with steps you run yourself in the real app. Slices are grouped
into four demos; a demo is the point where you test the whole flow, not a fragment.

**Test PR for every step:** `https://github.com/teambruno/bruno-enterprise-edition/pull/1829`
(111 files, 17 commits). Its facts below were checked against the code by hand.

**Start the app for any step:**

```sh
cd ~/Desktop/doubt && git switch <slice-branch> && npm run ui:build && npm start -- https://github.com/teambruno/bruno-enterprise-edition/pull/1829
```

Click the page once after it opens so it has keyboard focus.

**Each slice is done when:** built on its own branch, run against PR 1829, self-reviewed with
`/pr-review`, PR opened, and **you** have ticked "verified" here after running its steps.

---

## Demo A: safe and correct (do first)

### 0. Safety ([PR #2](https://github.com/arpitnath/doubt/pull/2))
- **What changes:** a PR checkout can't configure your Claude; other websites can't drive the daemon; no git or gh call can hang it; opens, views, verdicts and doubts go to `~/.doubt/events.jsonl`.
- **Try it:**
  1. Open PR 1829, press `a`, start a **new** session.
  2. In a terminal run `ps -axo args | grep "^claude"`.
  3. Read two files, mark one read, then run `tail -4 ~/.doubt/events.jsonl`.
- **You should see:** `claude --setting-sources user` for the session in the PR checkout. JSON lines for the `open`, two `view`s and a `verdict`.
- **Today:** the session loads the PR's own `.claude/settings.json`; no event log exists.
- [x] built · [ ] verified

### 3.1 References and definitions through the project's aliases ([PR #3](https://github.com/arpitnath/doubt/pull/3))
- **What changes:** the language engine reads each package's `jsconfig.json`/`tsconfig.json` instead of made-up settings.
- **Try it:**
  1. Open `packages/bruno-app/src/hooks/useDebounce/index.js`.
  2. `⌘⌥`-click `useDebounce` on line 11 (references).
  3. Open `packages/bruno-app/src/components/AppWebviewPane/index.js`, `⌘`-click `EmptyAppState` on line 2.
- **You should see:** references in **8 files**, including `Sidebar/Collections/index.js`. `EmptyAppState` opens `components/EmptyAppState/index.js` at line 8.
- **Today:** references in **2 files** (the hook and its test). `EmptyAppState` stops at the import line.
- [x] built · [ ] verified

---

## Demo B: the new review screen

### 1.1 Themes
- **What changes:** dark, dim and light themes, remembered across reloads.
- **Try it:** switch theme from the top bar, open a diff, reload the page.
- **You should see:** every surface changes, the diff included, and the choice survives the reload.
- **Today:** one dark theme.
- [x] built · [ ] verified

### 1.2 Buttons instead of keys
- **What changes:** top bar gets Description, Sync, Agent, ⌘K. File bar gets ‹ ›, Unified/Split, Changes/Whole file, **Mark read**. Keys shrink to `j k space u ⌘K esc`.
- **Try it:** review three files using **only the mouse**: open, switch Split, switch Whole file, Mark read, ›.
- **You should see:** every step has a visible control; Mark read moves to the next unread file.
- **Today:** 28 single-key shortcuts, several with no button.
- [ ] built · [ ] verified

### 1.3 One ⌘K palette
- **What changes:** one palette for files and actions, replacing the separate open, search and outline palettes.
- **Try it:** press `⌘K`, type `debounce`, open the file; press `⌘K`, type `split`, run it.
- **You should see:** files and actions in one list; running an action closes the palette.
- **Today:** `p`, `g` and `o` open three different palettes.
- [ ] built · [ ] verified

### 1.4 Line actions
- **What changes:** a `+` in the gutter and click-a-line open *Ask a doubt*, *Go to definition*, *Who touched this*, *Copy ref*.
- **Try it:** in `useDebounce/index.js` click line 22, then each action.
- **You should see:** Who touched this lists the real commit and PR for that line; Copy ref copies `packages/bruno-app/src/hooks/useDebounce/index.js:22`.
- **Today:** select lines, then remember `d`, `b`, `y`, `⌘`-click.
- [ ] built · [ ] verified

---

## Demo C: doubt → agent

### 2.1 Send-to picker
- **What changes:** the doubt box gets a "Send to" list of your Claude sessions, grouped by what they will see: this PR, other PRs, your clone of the repo, new. Each group says what to expect. Defaults to the newest session for this PR, then remembers your last pick.
- **Try it:** click a line, Ask a doubt, open Send to.
- **You should see:** your two earlier PR #1829 sessions under *This PR*; the #1876 and #1826 sessions under *Other PRs* with a "different checkout" warning; `~/Desktop/bruno` sessions under *Your clone* with their branch.
- **Today:** the comment goes to whichever terminal tab happens to be active.
- [ ] built · [ ] verified

### 2.2 Agent panel
- **What changes:** the real Claude Code terminal in a right panel you can show and hide, one tab per session. Sending to "new" starts Claude in the PR checkout first, then delivers the doubt.
- **Try it:** send a doubt to **New session**; then send a second doubt to an existing #1829 session.
- **You should see:** the panel opens; the new session starts and receives the full message (file, line, PR, head, code, your question) with nothing cut off; the second doubt opens a second tab.
- **Today:** start a session by hand first; a comment typed into a session that is still starting can be lost.
- [ ] built · [ ] verified

### 2.3 Updates tray
- **What changes:** a list at the top of the agent panel: each doubt with file:line, question, status and session. New answers get a dot and the Agent button shows "n new".
- **Try it:** send a doubt, then move to another file with › before it is answered.
- **You should see:** the item gets a dot and the button shows "1 new"; clicking the item opens the file at that line with the answer under it.
- **Today:** answers show only under their line and in the Doubts tab.
- [ ] built · [ ] verified

---

## Demo D: hover

### 3.2 Hover card
- **What changes:** hover any name in the diff for its signature, doc, where it is defined, and "used in N files, k changed in this PR". Library names say their types are not installed; built-ins say so.
- **Try it:** in `AppWebviewPane/index.js` hover `EmptyAppState`, `AppWebviewPane`, `React`; in `useDebounce/index.js` hover `useState`, `setTimeout`.
- **You should see:**
  - `EmptyAppState`: `({ title, hint, onAddCode }) => …`, defined at `EmptyAppState/index.js:8`, used in 4 files, the other 3 all changed in this PR.
  - `AppWebviewPane`: used in 3 files, `AppView` and `CollectionApp` changed in this PR.
  - `React`, `useState`: from `react`, types not installed.
  - `setTimeout`: built into JavaScript and the browser.
- **Today:** no hover.
- [ ] built · [ ] verified

### 3.3 Signature before and after
- **What changes:** when this PR changed a signature, the card shows it before and after.
- **Try it:** hover `useDebounce` (line 11) and `delay` in `useDebounce/index.js`; hover `shutdown` in `packages/bruno-electron/src/ipc/mount.js`.
- **You should see:**
  - `useDebounce`: before `(value, delay)`, after `(value, delay, { shouldSkipDebounce })`.
  - `delay`: before `any`, after `number`.
  - `shutdown`: before `() => …`, after `(opts) => …`.
- **Today:** no way to see this without opening the base file.
- [ ] built · [ ] verified

---

## Order

**A → B → C → D**, each slice merged before the next starts. 3.1 sits in Demo A because doubt gives wrong
reference counts today without saying so. B comes before C because the agent panel and tray need the new
layout. D comes last because hover needs 3.1 and the line layer from 1.4.

## Risks

- **Delivering to a session that just started (2.2):** the CLI needs a moment, and asks to trust a folder it has not seen, before it accepts typed text. Wait for its prompt before typing.
- **`ui/src/App.tsx` is 736 lines:** move the palette, tray and doubt box into their own files as each is built, not up front.
- **Hover speed:** the engine takes about 2s to build per PR, then answers in under 100ms. Build it in the background when a PR opens so the first hover is not slow.

## Parked

Search across the diff and the repo; signals redesign (secret scanning, AST duplicate detection); fast open
with shared worktrees and TTL cleanup; repair mode.
