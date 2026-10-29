# drift

An agent turn can change files you never asked it to touch. A dependency's postinstall adds a line to `~/.zshrc`, a setup script points `~/.npmrc` at another registry, an "install" adds a LaunchAgent. Claude Code's protected paths only prompt when Claude itself writes those files, not when a command it runs does.

drift snapshots your global config when a session starts and diffs it after every tool call. When something changed, the same turn ends with the lines that changed, the command that changed them, and an undo. On every other turn it says nothing.

```
/plugin marketplace add davekiss/mods
/plugin install drift@davekiss
```

## What it watches

- Shell: `~/.zshrc`, `.zprofile`, `.zshenv`, `.bashrc`, `.bash_profile`, `.profile`, fish config
- Git, npm, yarn, bun, pip: `~/.gitconfig`, `~/.npmrc`, `.yarnrc.yml`, `.bunfig.toml`, `pip.conf`
- SSH and AWS: `~/.ssh/config`, `~/.ssh/authorized_keys`, `~/.aws/config`
- Agents: `~/.claude/settings.json`, `~/.codex/config.toml`
- Startup: `crontab`, `~/Library/LaunchAgents`, systemd user units, autostart
- The global npm package list

## Commands

- `/drift:log`: every change this session, with the command that made it
- `/drift:undo`: restore every changed file to how it was when the session started
- `/drift:undo 2`: restore just one change

For global npm packages it prints the `npm rm -g` line instead of running it.

## Fixture mode

`node drift.mjs selftest` makes a throwaway home, changes one file of each kind, and prints what drift flags. `node drift.mjs log --json` prints the latest session's changes as JSON.

## What it can't catch

drift sees writes, not reads. A script that reads `~/.npmrc` and sends your token somewhere changes nothing, so drift stays quiet. Set `npm config set ignore-scripts true`, or run installs in a sandbox, to stop that kind.

Snapshots, including the old file contents for undo, live in `~/.claude/drift/` on your machine and go nowhere else.
