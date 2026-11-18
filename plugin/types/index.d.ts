// What the context-graph mod keeps in $.state: the latest activity and
// snapshot from the p2p-context-graph MCP server, and the panel's choices.

export type Person = {
  name: string
  fingerprint: string
  role: 'reader' | 'contributor' | 'admin' | null
  you: boolean
  creator: boolean
  online: boolean
  agent: string | null
  platform: string | null
}

export type Change = {
  id: string
  kind: string
  at: string
  by: string
  mine: boolean
  summary: string
  node: string | null
  held: boolean
  shared_at: string | null
}

export type GraphNode = {
  id: string
  key: string
  label: 'Claim' | 'Question'
  title: string
  ended: boolean
  props: Record<string, unknown>
}

export type GraphEdge = { type: string; source: string; target: string }

export type Activity = {
  using: string
  graph: string
  created_by: string | null
  you: { name: string; role: Person['role']; fingerprint: string }
  sharing: boolean
  online: string[]
  members: number
  people: Person[]
  relays_up: number
  changes: number
  recent: Change[]
  your_graphs: string[]
  snapshot?: { nodes: GraphNode[]; edges: GraphEdge[]; truncated: boolean }
}

export type Tab = 'graph' | 'items' | 'people'

/** The latest line from someone else, for the band. */
export type Latest = { by: string; summary: string; at: string }

declare module 'claude-code' {
  interface PluginState {
    'p2p-context-graph': {
      activity: Shaped<Activity | null>
      latest: Latest | null
      tab: Tab
      code: string | null
      notice: string | null
      error: string | null
      confirmRemove: string | null
    }
  }
}
