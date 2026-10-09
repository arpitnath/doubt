# doubt

A reading tool for PRs at agent volume. Working name, personal project.

Walk a PR one chunk at a time. Each chunk gets one of two verdicts: **understood** (settled, hidden) or **doubt** (a located question routed to a Claude session that already holds the whole PR). Approve means understood, not verified. Claude answers when asked; it never pre-grades.

Status: PoC not started. Architecture and decisions live in the ref note:

- `~/Desktop/refs/doubt-poc.md`

Stack: TypeScript on Bun, React + @pierre/diffs, Claude via @anthropic-ai/claude-agent-sdk, git and gh as child processes. No Go, no Rust, no Electron for the PoC.

Done means: three real PRs reviewed with the tool alone, and honest answers to whether any chunk was approved without being understood.
