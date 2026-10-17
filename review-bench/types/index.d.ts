export type Plant = { id: number; kind: string; file: string; line: number; after: string }
export type Round = { round: number; newCaught: number[]; caughtSoFar: number; newOther: number; costUsd: number | null; sec: number }
export type Finding = { file: string; line: number; issue: string }
export type Bench = { repo: string; seed: number; plants: Plant[]; rounds: Round[]; findings: { k: number; findings: Finding[] }[]; verdict: string | null }

declare module 'claude-code' {
  interface PluginState {
    'review-bench': { bench: Bench | null; status: string | null; error: string | null }
  }
}
