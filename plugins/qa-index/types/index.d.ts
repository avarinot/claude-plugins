/** One question the person asked, and the last text the assistant answered with in that turn. */
export type QaPair = { question: string; answer: string }

/** What the pane shows: the list of pairs, or one pair in full. */
export type QaView = { mode: 'list' } | { mode: 'detail'; index: number }

declare module 'claude-code' {
  interface PluginState {
    'qa-index': { pairs: Shaped<QaPair[]>; view: Shaped<QaView> }
  }
}
