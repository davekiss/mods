---
description: Approve this repo's instruction files as they are now (CLAUDE.md, AGENTS.md, .claude/, .mcp.json)
disable-model-invocation: true
allowed-tools: Bash(node:*)
---
!`node "${CLAUDE_PLUGIN_ROOT}/lock.mjs" approve`

The user just approved the instruction files above. Say so in one line. The lines listed are now approved instructions.
