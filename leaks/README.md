# leaks

A Claude Code mod that finds where your week went and fixes it.

- **`/leaks`** opens a pane that ranks the avoidable spend in your last 7 days of transcripts (`/leaks --days 30` for more), each leak with what it cost and the fix. A fix that's a setting or a CLAUDE.md line applies with one press (`a`).
- **The strip** above the prompt flags a leak while it's happening: a context past 400k that every turn re-reads, or a cache about to expire (or already expired) on a big conversation, with what your next message will re-write. Press "compact now" to shrink it first.

## What it finds

- **Sessions past the compact point.** Every turn re-reads the whole conversation, so a turn at 800k costs four times one at 200k. Each session is replayed as if it had compacted at 400k, and the difference is the saving. Fix: `"autoCompactWindow": 400000` in `~/.claude/settings.json`.
- **Cache rebuilt after a break.** Coming back after the cache expired (an hour for Claude Code's 1h cache, 5 minutes for the 5m one) re-writes the whole conversation at cache-write price. Fix: `/clear` or `/compact` before you carry on.
- **Read-only subagents on a big model.** Agent types whose runs only read, priced again at Haiku rates. Fix: `model: haiku` in the agent's frontmatter.
- **Huge tool outputs carried along.** A tool result of about 8k tokens or more that every later turn paid to re-read. Fix: a CLAUDE.md line to grep or read a range.

It reads `~/.claude/projects` on your machine (every response's `message.usage`) and prices each call at the API rates in `leaks.mjs`. Nothing leaves your machine. Needs Node 22+.

## Install

```
/plugin marketplace add davekiss/mods
/plugin install leaks@davekiss
```

Then start a new session and run `/leaks`. From a checkout: `claude --plugin-dir ./leaks`. The engine also runs on its own: `node leaks.mjs` (`--days 30`, `--top 10`, `--json`, `--compact-at 300k`).

## Read it right

- Dollars are API-equivalent. On a subscription they're your share of the limit, not a bill.
- Savings are estimates and overlap a little: compacting earlier also shrinks the cache rebuilds. Compacting trades detail for cost, since the conversation becomes a summary.
- Tool-output sizes are estimated at about 4 characters per token.

## Develop

`claude plugin test .` runs the tests in `tests/`.
