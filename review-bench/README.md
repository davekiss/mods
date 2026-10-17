# review-bench

Does another review round find real bugs, or just new noise? `/review-bench` answers that on your own repo.

It plants N known bugs (off-by-one, missing await, wrong auth check, unhandled null, swapped args), one token each, in a throwaway `git worktree` on a `review-bench/*` branch. Your working tree is never touched. Then it runs review rounds with `claude -p`. Each round reads the source files around the plants (never told bugs were planted) and is told what earlier rounds already reported. Each round is scored:

- **planted**: planted bugs this round newly caught (same file, line within ±3)
- **other**: new findings that match no planted bug. They're unchecked, not "false": some may be real.

The verdict names the round after which no planted bug was caught.

## Install

```
/plugin marketplace add davekiss/mods
/plugin install review-bench@davekiss
```

Then run `/review-bench` (or `/review-bench --n 5 --rounds 3`) in a git repo. Set a reviewer model in the plugin's options, or `REVIEW_BENCH_MODEL=sonnet`. Press `c` to remove the worktree.

## Without the pane

```sh
node review-bench.mjs plant --n 5 --seed 1
node review-bench.mjs round 1 && node review-bench.mjs round 2 && node review-bench.mjs round 3
node review-bench.mjs report --json
node review-bench.mjs clean
```

Each round is one `claude -p` run, with Read/Grep/Glob only, and its cost shows in the pane.

## Develop

`node --test tests/engine.spec.mjs`
