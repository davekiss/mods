# skill-audit

A Claude Code mod that shows which installed skills and plugins your agent actually used in the last 30 days, counted from your own session transcripts, and turns the rest off with one press.

- `/skill-audit` opens a pane with every skill Claude loaded (how many times, and when it last did), every installed skill or plugin it never used, and about how many context tokens those cost every session (est.: name and description at 4 characters a token).
- Press `o` to turn off everything unused. Plugins are switched off in `~/.claude/settings.json` (`enabledPlugins`), and user skills move to `~/.claude/skills-disabled/`. Both take effect in your next session.
- Press `u` to undo: everything goes back the way it was.

Uses are Skill tool calls, plugin MCP tool calls, and slash commands you typed (`/name`), all read from `~/.claude/projects/**/*.jsonl`. Nothing leaves your machine.

## Install

```
/plugin marketplace add davekiss/mods
/plugin install skill-audit@davekiss
```

## Keep a skill you rarely use

Set the plugin's `keep` option to a comma-separated list of names, and `/skill-audit` never turns them off.

## Without the pane

```sh
node skill-audit.mjs                 # the audit as text (--days 60, --json, --dir ~/.claude)
node skill-audit.mjs off             # turn off everything unused (--keep a,b)
node skill-audit.mjs undo            # put it back
```

## Develop

`node --test tests/engine.spec.mjs`
