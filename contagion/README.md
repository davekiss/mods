# contagion

A Claude Code mod that finds the existing line your agents copied each escape hatch from.

For every `as any`, `@ts-ignore`/`@ts-expect-error`, `eslint-disable`, swallowed catch (`catch {}`, `.catch(() => {})`) and "hack/workaround" comment added in a commit with an agent Co-Authored-By trailer (Claude, Codex, Cursor, Copilot, Devin, OpenCode, Aider), `/contagion` looks at the code as it was just before that commit and finds the most similar existing line of the same kind (token overlap, same file or folder first). It ranks those patient zeros by how many copies they seeded. A line with no close match counts as no source; it is never forced.

Press `a` to add one line to the repo CLAUDE.md naming the patient zeros, so the next agent is told not to copy them.

## Install

```
/plugin marketplace add davekiss/mods
/plugin install contagion@davekiss
```

Then run `/contagion` (or `/contagion --days 90`) in a git repo.

## Without the pane

```sh
node contagion.mjs --days 180          # text
node contagion.mjs --json              # the whole report
node contagion.mjs fix --top 5         # add the CLAUDE.md line
```

"Copied from" is a likely source by similarity, not proof. Short idioms like `.catch(() => {})` match easily.

## Develop

`node --test tests/engine.spec.mjs`
