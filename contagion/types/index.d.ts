export type Source = { file: string; line: number; text: string; score: number }
export type Added = { sha: string; file: string; line: number; text: string; kind: string; at: string; source: Source | null }
export type Zero = { file: string; line: number; text: string; kind: string; copies: { file: string; line: number; sha: string; score: number }[] }
export type Report = { repo: string; days: number; agentCommits: number; added: Added[]; traced: number; untraced: number; zeros: Zero[] }

declare module 'claude-code' {
  interface PluginState {
    contagion: { report: Report | null; isLoading: boolean; error: string | null; fixed: boolean }
  }
}
