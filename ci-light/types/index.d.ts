// The light, as ci-light.mjs --json writes it.
export type Light = {
  repo: string | null
  branch: string | null
  state: 'red' | 'green' | 'running' | 'unknown' | 'none' | 'error'
  since: string | null
  pushes: number
  more: boolean
  running: boolean
  workflows: string | null
  error?: string
  text: string
  line: string
}

declare module 'claude-code' {
  interface PluginState {
    'ci-light': { light: Light | null; hidden: string | null; told: string | null }
  }
}
