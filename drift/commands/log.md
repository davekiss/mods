---
description: Show every change outside the project this session, with the command that made it
---
!`DRIFT_SESSION="${CLAUDE_SESSION_ID}" node "${CLAUDE_PLUGIN_ROOT}/drift.mjs" log`

Above is drift's log for this session. Tell the user in plain words what changed outside the project and which command did it. If something looks unexpected for what they asked, say so first and offer `/drift:undo`.
