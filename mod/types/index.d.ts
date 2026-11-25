export type FigmaNode = { id: string; type: string; name: string }

export type FigmaSelection = {
  fileKey: string | null
  fileName: string
  page: { id: string; name: string }
  nodes: FigmaNode[]
  count: number
}

declare module 'claude-code' {
  interface PluginState {
    'tether': {
      current: Shaped<FigmaSelection | null>
      lastSent: string | null
    }
  }
}
