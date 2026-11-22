import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, SessionMessage } from 'claude-code'

import type { QaPair, QaView } from '../types'

const PANE = 'qa-index'
const TITLE = 'Q/R'
// Change a tag when the stored value's fields change: it declines what an
// earlier version stored, which outlives a reload.
const pairs = atom({ plugin: 'qa-index', key: 'pairs' } as const, [] as QaPair[], { shape: 'pairs-1' })
const view = atom({ plugin: 'qa-index', key: 'view' } as const, { mode: 'list' } as QaView, {
  shape: 'view-2',
})

// Blocks the engine adds to a user message that the person did not type.
const NOISE = [
  /<system-reminder>[\s\S]*?<\/system-reminder>/g,
  /<task-notification>[\s\S]*?<\/task-notification>/g,
  /<command-(name|message|args)>[\s\S]*?<\/command-\1>/g,
  /<local-command-(stdout|stderr|caveat)>[\s\S]*?<\/local-command-\1>/g,
  /<agent-message[\s\S]*?<\/agent-message>/g,
]

function cleanQuestion(text: string): string {
  let out = text
  for (const re of NOISE) out = out.replace(re, '')
  // Keep what a pasted block holds, drop its wrapping tags.
  return out.replace(/<\/?pasted_content[^>]*>/g, '').trim()
}

/** One pair per question the person typed; its answer is the turn's last assistant text. */
export function toPairs(messages: readonly SessionMessage[]): QaPair[] {
  const out: QaPair[] = []
  for (const m of messages) {
    if (m.role === 'user') {
      if (m.toolResults !== undefined && m.toolResults.length > 0 && m.text.trim() === '') continue
      const question = cleanQuestion(m.text)
      if (question !== '') out.push({ question, answer: '' })
    } else {
      const last = out.at(-1)
      if (last !== undefined && m.text.trim() !== '') last.answer = m.text.trim()
    }
  }
  return out
}

/** The answer's first paragraph, without emphasis marks: the gist, as the answer opens with it. */
export function gist(answer: string): string {
  const first = answer.split(/\n\s*\n/).find(p => p.trim() !== '') ?? ''
  return first.replace(/\*\*|__|`/g, '').replace(/\s+/g, ' ').trim()
}

const oneLine = (text: string) => text.replace(/\s+/g, ' ').trim()
const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text)
const LIST: QaView = { mode: 'list' }
const detail = (index: number): QaView => ({ mode: 'detail', index })

type Content = string | ReadonlyArray<{ type?: string; text?: string }> | undefined
type Entry = {
  type?: string
  isSidechain?: boolean
  isMeta?: boolean
  isCompactSummary?: boolean
  message?: { content?: Content }
}

function textOf(content: Content): string {
  if (typeof content === 'string') return content
  if (content === undefined) return ''
  return content
    .filter(b => b.type === 'text' && typeof b.text === 'string')
    .map(b => b.text)
    .join('\n')
}

const PREVIOUS = /full transcript at: (\S+?\.jsonl)/

/**
 * Folds one transcript line into [out]: a typed question opens a pair, assistant text answers the last
 * one. Returns the earlier transcript file a summary of the conversation points at, if any.
 */
export function foldLine(out: QaPair[], line: string): string | undefined {
  if (line.trim() === '') return undefined
  let entry: Entry
  try {
    entry = JSON.parse(line) as Entry
  } catch {
    return undefined
  }
  if (entry.isSidechain === true || entry.message === undefined) return undefined
  if (entry.type === 'user') {
    if (entry.isCompactSummary === true) return PREVIOUS.exec(textOf(entry.message.content))?.[1]
    if (entry.isMeta === true) return undefined
    const question = cleanQuestion(textOf(entry.message.content))
    if (question !== '') out.push({ question, answer: '' })
  } else if (entry.type === 'assistant') {
    const text = textOf(entry.message.content).trim()
    const last = out.at(-1)
    if (last !== undefined && text !== '') last.answer = text
  }
  return undefined
}

// What has been read of each transcript file: a reload starts it over, as it should.
const CHUNK = 4 * 1024 * 1024 - 1024
type Cursor = { offset: number; carry: string; pairs: QaPair[]; previous?: string }
const cursors = new Map<string, Cursor>()

async function advance($: EngineInterface, path: string): Promise<Cursor> {
  const { size } = await $.fs.stat(path)
  let cursor = cursors.get(path)
  if (cursor === undefined || size < cursor.offset) {
    cursor = { offset: 0, carry: '', pairs: [] }
    cursors.set(path, cursor)
  }
  while (cursor.offset < size) {
    const length = Math.min(CHUNK, size - cursor.offset)
    const chunk = await $.fs.read(path, { offset: cursor.offset, length })
    cursor.offset += length
    const lines = (cursor.carry + chunk).split('\n')
    cursor.carry = lines.pop() ?? ''
    for (const line of lines) {
      const previous = foldLine(cursor.pairs, line)
      // A summary written in the same file keeps what it summed up above it.
      if (previous !== undefined && previous !== path) cursor.previous ??= previous
    }
  }
  return cursor
}

/**
 * The whole conversation, from its transcript file and the earlier ones a summary of it points at
 * (a conversation continued after running out of context goes on in a new file).
 */
async function readTranscript($: EngineInterface): Promise<QaPair[] | undefined> {
  const { transcriptPath } = await $.session.info()
  if (transcriptPath === '') return undefined
  const files: Cursor[] = []
  const seen = new Set<string>()
  for (let path: string | undefined = transcriptPath; path !== undefined && !seen.has(path); ) {
    seen.add(path)
    const cursor: Cursor = await advance($, path)
    files.unshift(cursor)
    path = cursor.previous !== undefined && (await $.fs.exists(cursor.previous)) ? cursor.previous : undefined
  }
  const all = files.reduce<QaPair[]>((done, f) => join(done, f.pairs), [])
  // The line being written, if complete, without keeping it as read.
  const tail: QaPair[] = []
  foldLine(tail, cursors.get(transcriptPath)?.carry ?? '')
  return join(all, tail)
}

const OVERLAP = 10

/**
 * [earlier] then [later], each pair once: a continued conversation's new file opens again with the
 * last questions of the one before, and a question resent before any answer replaces the first.
 */
export function join(earlier: readonly QaPair[], later: readonly QaPair[]): QaPair[] {
  const out = earlier.map(p => ({ ...p }))
  later.forEach((pair, index) => {
    const last = out.at(-1)
    if (last !== undefined && last.answer === '' && pair.question.startsWith(last.question)) {
      out[out.length - 1] = { ...pair }
      return
    }
    const from = Math.max(0, earlier.length - OVERLAP)
    const twin = index < OVERLAP ? out.findIndex((p, i) => i >= from && i < earlier.length && p.question === pair.question) : -1
    if (twin === -1) {
      out.push({ ...pair })
    } else if (pair.answer !== '') {
      out[twin] = { ...pair }
    }
  })
  return out
}

async function refresh($: EngineInterface): Promise<void> {
  let list: QaPair[] | undefined
  try {
    list = await readTranscript($)
  } catch {
    cursors.clear()
  }
  if (list === undefined) {
    const messages = await $.session.messages()
    if ('deny' in messages) return
    list = toPairs(messages)
  }
  const found = list
  await update($, pairs, () => found)
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'qa',
      description: 'Questions/réponses de la session : /qa pour la liste, /qa N pour la réponse N en entier',
    })
    await refresh($)
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    if (e.agentId === undefined) await refresh($)
    return done
  })

  on('command.run', { command: 'qa' }, async ($, e) => {
    await refresh($)
    const list = await read($, pairs)
    const n = Number.parseInt(e.args.trim(), 10)
    if (Number.isInteger(n) && n >= 1 && n <= list.length) {
      await update($, view, () => detail(n - 1))
    } else {
      await update($, view, () => LIST)
    }
    await $.ui.open({ id: PANE, title: TITLE, focus: true, closeOnEscape: true, rows: 30 })
    return { text: `${list.length} question(s) — Échap pour fermer le panneau.` }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button, Markdown } = $.ui.resolve(e)
    const list = await read($, pairs)
    const current = await read($, view)

    if (list.length === 0) return <Text dimColor>Pas encore de question dans cette session.</Text>

    // The pane scrolls what is taller than it: the arrows, once it has the keyboard.
    const pair = current.mode === 'detail' ? list[current.index] : undefined
    if (current.mode === 'detail' && pair !== undefined) {
      const index = current.index
      const go = (to: number) => update($, view, () => detail(to))
      return (
        <Box flexDirection="column" gap={1}>
          <Box flexDirection="row" columnGap={3}>
            <Button key="back" hotkey="b" plain autoFocus onPress={() => update($, view, () => LIST)}>
              Liste
            </Button>
            {index > 0 ? (
              <Button key="prev" hotkey="p" plain onPress={() => go(index - 1)}>
                Précédente
              </Button>
            ) : null}
            {index < list.length - 1 ? (
              <Button key="next" hotkey="n" plain onPress={() => go(index + 1)}>
                Suivante
              </Button>
            ) : null}
          </Box>
          <Box flexDirection="column" borderStyle="round" borderColor="border-accent" paddingX={1}>
            <Text color="text-accent" bold>
              Question {index + 1} sur {list.length}
            </Text>
            <Text>{pair.question}</Text>
          </Box>
          <Text color="text-accent" bold>
            Réponse
          </Text>
          <Markdown text={pair.answer || '_(pas encore de réponse)_'} />
        </Box>
      )
    }

    // Newest first: the question just asked is the one looked for most.
    const newestFirst = list.map((one, index) => ({ one, index })).reverse()
    return (
      <Box flexDirection="column">
        <Text dimColor>↑↓ choisir · Entrée lire la réponse · Échap fermer</Text>
        {newestFirst.map(({ one, index }, row) => (
          <Box key={`pair-${index}`} flexDirection="column" marginTop={1}>
            <Button
              key={`q-${index}`}
              plain
              autoFocus={row === 0 ? true : undefined}
              onPress={() => update($, view, () => detail(index))}
            >
              <Text color="text-accent" bold>{`Q${index + 1}  `}</Text>
              {clip(oneLine(one.question), 110)}
            </Button>
            <Box paddingLeft={4}>
              <Text dimColor maxLines={2}>
                {one.answer === '' ? '(en cours…)' : `→ ${gist(one.answer)}`}
              </Text>
            </Box>
          </Box>
        ))}
      </Box>
    )
  })
}
