export type Item = {
  kind: 'skill' | 'command' | 'plugin'
  id: string
  name: string
  on: boolean
  tokens: number
  uses: number
  lastUsed: number | null
  skills?: string[]
  commands?: string[]
  mcp?: string[]
}

export type Audit = {
  days: number
  sessions: number
  items: Item[]
  unused: string[]
  unusedTokens: number
  totalTokens: number
}

declare module 'claude-code' {
  interface PluginState {
    'skill-audit': { report: Audit | null; isLoading: boolean; error: string | null; done: string | null }
  }
}
