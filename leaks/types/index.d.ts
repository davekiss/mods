// One row of the report, as leaks.mjs --json writes it.
export type Leak = { kind: 'context' | 'cache' | 'subagent' | 'output'; save: number; title: string; detail: string; fix: string; apply?: string }

export type Report = { total: number; pastCompact: number; compactAt: number; autoCompactWindow: number | null; calls: number; leaks: Leak[]; days: number; at: number }

// What the strip above the prompt knows about the session right now.
export type Live = { tokens: number; window: number; week: number | null; lastTurnAt: number | null }

declare module 'claude-code' {
  interface PluginState {
    leaks: { report: Report | null; isLoading: boolean; error: string | null; applied: string[]; live: Live; hidden: string | null; selected: number }
  }
}
