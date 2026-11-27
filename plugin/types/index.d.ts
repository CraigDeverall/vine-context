// What the vine-context mod keeps in $.state: the latest activity and
// snapshot of this chat's context from the MCP server, and the panel's choices.

export type Person = {
  name: string
  fingerprint: string
  role: 'reader' | 'contributor' | 'admin' | null
  you: boolean
  creator: boolean
  online: boolean
  /** When they joined (absent from older servers). */
  joined_at?: string
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
  label: 'Claim' | 'Question' | 'Reply'
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
  /** The context this activity is about (the one the panel shows). */
  context: string
  description: string | null
  /** This chat's contexts: usually one. */
  contexts: { name: string; description: string | null; role: Person['role']; writes_here: boolean }[]
  /** The folder this chat started in, and whether new chats there start with this chat's contexts. */
  /** `pinned`: the contexts new chats in that folder start with (absent from older servers). */
  folder: { folder: string; linked: boolean; pinned?: string[] } | null
  your_contexts: string[]
  digest: { at: string; lines: string[] }[]
  /** An admin's open join codes, newest first (absent for other roles). */
  invites?: Invite[]
  snapshot?: { nodes: GraphNode[]; edges: GraphEdge[]; truncated: boolean }
}

/** A join code waiting for its one person. */
export type Invite = {
  id: string
  label: string | null
  role: 'reader' | 'contributor' | 'admin'
  code: string
  created_at: string
  expires_at: string
}

/** One of this machine's contexts in full (the server's `context_info` with `details`), for the panel's details view. */
export type ContextDetails = {
  name: string
  id: string | null
  description: string | null
  role: Person['role']
  /** Whether you made it. */
  yours: boolean
  created_by: string | null
  in_chat: boolean
  writes_here: boolean
  sharing: boolean
  members: number
  /** How many of the other members are online. */
  online: number
  /** How many items of each kind it holds, withdrawn ones included. */
  items: Record<string, number>
  changes: number
  held: number
  /** Join codes waiting to be used; null unless you're an admin. */
  open_invites: number | null
  stored_at: string
}

export type Tab = 'overview' | 'questions' | 'claims' | 'people' | 'settings'

/** What the Questions and Claims lists show: the words to match, and which part of each list. */
export type Filters = {
  text: string
  claims: 'current' | 'mine' | 'conflicts' | 'history'
  questions: 'open' | 'answered' | 'mine'
}

/**
 * What the server's search (meaning plus keywords) found for the filter's text
 * in a context, best first: item ids, or null while it's looking.
 */
export type Found = { text: string; context: string; ids: string[] | null; failed?: boolean }

/** The latest line from someone else, for the band. */
export type Latest = { by: string; summary: string; at: string }

declare module 'claude-code' {
  interface PluginState {
    'vine-context': {
      activity: Shaped<Activity | null>
      latest: Latest | null
      tab: Shaped<Tab>
      /** The invite just made (its id), marked in the list until another is made. */
      code: string | null
      /** The new-invite step: the context it's for (on or off for this chat) and the role picked; null while it's closed. A value from before it named the context is ignored. */
      inviting: { name: string; role: Invite['role'] } | null
      notice: string | null
      error: string | null
      confirmRemove: string | null
      /** The new-context step (the panel shows only that), with what's wrong with what was typed; null while it's closed. */
      creating: { error: string | null } | null
      /** A context that's off for this chat (by name), shown on its own page: it can't be opened. Null is the list. */
      managing: string | null
      /** The details (`context_info` with `details`) of that context, or of the open context's Settings tab, once the server has answered. */
      details: ContextDetails | null
      /** The context whose deletion is being confirmed (the panel shows only that), with what's wrong with what was typed. */
      deleting: { name: string; error: string | null } | null
      /** The context whose description is being edited (the panel shows only that); false while no one is. A `true` from before it named the context is ignored. */
      editing: string | boolean
      /** The context being renamed on this machine (the panel shows only that); null while none is. */
      renamingContext: string | null
      /** Whether the panel shows the chat's contexts, to turn on and off, instead of a context. */
      switching: boolean
      /** Which of the chat's contexts the panel shows; null is the one writes go to. */
      viewing: string | null
      /** Counts up while the band waits for the server, to animate "loading…". */
      tick: number
      /** The item (a claim's or question's id) the panel shows on its own; null is the lists. */
      detail: string | null
      /** Whether your name is being changed (the panel shows only that). */
      renaming: boolean
      filters: Filters
      /** The search behind the filter's text: the lists add its best matches to those that share its words. */
      found: Found | null
      /** How many more items than the first page a list shows. */
      more: number
      /** The folded parts the person has opened ("3 more ▾"), by id: everything else shows only its first few. */
      folds: string[]
      /** With no context in this chat (there's no default): the contexts on this machine to choose from. Null while it has one. */
      unattached: string[] | null
    }
  }
}
