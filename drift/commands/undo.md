---
description: Put back the global files this session changed (shell rc, git, npm, ssh, cron…), or just change n
argument-hint: "[n]"
---
!`DRIFT_SESSION="${CLAUDE_SESSION_ID}" node "${CLAUDE_PLUGIN_ROOT}/drift.mjs" undo $ARGUMENTS`

Above is what drift restored. Tell the user in one or two plain sentences which files are back to how they were when the session started, and anything drift could only suggest (like an `npm rm -g` line).
