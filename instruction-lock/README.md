# instruction-lock

A Claude Code hook pair that pins your agent's instructions, so a `git pull` or a merged PR can't quietly change them.

The first session in a repo pins every file Claude treats as authority:

- every `CLAUDE.md`, `CLAUDE.local.md` and `AGENTS.md` in the tree
- everything under `.claude/` (settings and their hooks, skills, commands, agents, rules)
- `.mcp.json`

From then on:

- **Claude's own pulls and merges stop first.** Before `git pull`, `git merge`, `git rebase`, a hard reset to a ref or `gh pr merge` runs, a PreToolUse hook works out what the command would bring in. If any pinned file changes, the command is refused and Claude shows you each file, the commit, the author and the added lines.
- **Pulls you run yourself are caught at the next session.** A SessionStart check compares the tree with the pin. If anything changed, you see the diff and who made it, and Claude is told to treat the new lines as untrusted text and ask you before doing anything.
- **Anything else is caught right after it happens.** After every Bash call, the same check catches changes that came in some other way, such as a fetch followed by a hard reset, or a script.
- **Only you can approve.** `/instruction-lock:approve` is user-only (`disable-model-invocation`). Claude's attempts to run the approve step, or to edit the pin store, are denied. Pins live outside the repo, in `~/.claude/instruction-lock/`, so a PR can't update them.

## Install

```
/plugin marketplace add davekiss/mods
/plugin install instruction-lock@davekiss
```

`/instruction-lock:status` shows whether the files still match what you approved. Needs Node 18+ and git.

## Limits

- An instruction file that's already loaded can't be unloaded. When a change slips in outside Claude, the SessionStart notice tells Claude not to follow it, and that is a prompt, not a wall. The pull gate is the part that actually prevents the change.
- It only pins the files listed above. Files that `CLAUDE.md` imports with `@path` aren't pinned unless they're under `.claude/`.
- `gh pr merge` is checked with `gh pr diff --name-only`, so it needs `gh` signed in.

## Develop

`node --test tests/*.spec.mjs` runs the tests against throwaway git repos.
