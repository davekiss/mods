# ci-light

A Claude Code mod that tells you when main is broken, before you build on it.

- **A red row above the prompt** when your repo's default branch is failing CI: how long it's been red and how many pushes landed on top of the first failure.

  ```
  ● main is red   for 32d 22h   · 33 pushes on top   hide
  ```

- **A quiet word under the prompt** otherwise: `ci main ● green`, `◐` while a run is going.
- **The agent is told too.** Once per red streak, the next prompt carries a note that main is failing, so Claude checks whether its change touches the failure before saying it works.

A push is red if any of its workflow runs failed (failure, timed_out, startup_failure, action_required), green when its runs succeeded. Pushes whose runs were all cancelled or skipped don't count either way. A `+` means the streak goes past the last 100 runs.

## Install

```
/plugin marketplace add davekiss/mods
/plugin install ci-light@davekiss
```

Then start a new session in a GitHub repo. From a checkout: `claude --plugin-dir ./ci-light`.

## Only the workflows that matter

A repo with one chronically failing side workflow (benchmarks, nightly) would read red forever. Set the plugin's `workflow` option to the ones that decide red or green, by name or file: `ci`, or `ci.yml,test.yml`. As a statusline command, use `CI_LIGHT_WORKFLOW=ci`.

## As a plain statusline

The engine is one dependency-free Node file, and it also works as a statusline:

```sh
mkdir -p ~/.claude && cp ci-light.mjs ~/.claude/ci-light.mjs
```

```json
{ "statusLine": { "type": "command", "command": "node ~/.claude/ci-light.mjs" } }
```

It prints `main ● red 32d 22h · 33 pushes`. `node ci-light.mjs --json` prints the result as JSON, and `--fixture runs.json` reads `{ default_branch, workflow_runs }` from a file instead of GitHub.

## Read it right

- Uses `gh` when you're signed in (private repos too), otherwise the public GitHub API: 60 requests an hour without `GITHUB_TOKEN`, two per repo per refresh. A refused call shows `ci ? (GitHub 403)` for 30 s.
- Each repo is cached for 120 s (`CI_LIGHT_TTL` in seconds).
- Shows nothing outside a GitHub repo.

## Develop

`node --test tests/engine.spec.mjs` runs the engine's tests.
