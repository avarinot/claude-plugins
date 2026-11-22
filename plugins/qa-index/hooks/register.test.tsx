import { expect, test } from 'claude-code/testing'

import { foldLine, gist, join, toPairs } from './register'

const PANE = {
  plugin: 'qa-index',
  component: 'Pane',
  requestId: 'qa-index',
  props: {
    title: 'Q/R',
    isFocused: true,
    bodyColumns: 80,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 20 },
    view: {},
  },
} as const

const MESSAGES = [
  { role: 'user', text: 'décris les tests\n<system-reminder>bruit</system-reminder>', toolUses: [] },
  { role: 'assistant', text: 'Je regarde.', toolUses: [] },
  { role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: 't', text: 'ok', isError: false }] },
  { role: 'assistant', text: 'Voici **8 scénarios**.\n\n1. Full assessment', toolUses: [] },
  { role: 'user', text: '<task-notification>done</task-notification>', toolUses: [] },
  { role: 'user', text: 'et le push ?', toolUses: [] },
  { role: 'assistant', text: 'Poussé.', toolUses: [] },
] as const

test('one pair per typed question, answered by its last text, without the engine noise', () => {
  const list = toPairs(MESSAGES as never)

  expect(list).toEqual([
    { question: 'décris les tests', answer: 'Voici **8 scénarios**.\n\n1. Full assessment' },
    { question: 'et le push ?', answer: 'Poussé.' },
  ])
  expect(gist(list[0]?.answer ?? '')).toBe('Voici 8 scénarios.')
})

test('/qa opens the list, a press shows the answer in full', async ($, on) => {
  on('command.register', () => ({ value: { command: 'qa' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.messages', () => ({ value: MESSAGES as never }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('command.run', () => ({ text: '' }))

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.command.run({ command: 'qa', args: '' } as never)

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await ui.find({ type: 'Text', text: /Voici 8 scénarios/ }))?.text).toBe('→ Voici 8 scénarios.')

  await ui.press({ key: 'q-0' })
  expect(await ui.find({ type: 'Markdown', text: /1\. Full assessment/ })).toBeDefined()
  await ui.unmount()
})

test('the transcript file gives every pair, the compacted ones included', () => {
  const lines = [
    { type: 'user', message: { content: 'première question' } },
    { type: 'assistant', message: { content: [{ type: 'thinking', thinking: 'x' }, { type: 'text', text: 'Je regarde.' }] } },
    { type: 'user', message: { content: [{ type: 'tool_result', content: 'ok' }] } },
    { type: 'assistant', isSidechain: true, message: { content: [{ type: 'text', text: 'agent' }] } },
    { type: 'assistant', message: { content: [{ type: 'text', text: 'Réponse 1.' }] } },
    { type: 'user', isCompactSummary: true, message: { content: 'Summary: ...' } },
    { type: 'user', isMeta: true, message: { content: 'caveat' } },
    { type: 'user', message: { content: '<command-name>/qa</command-name>' } },
    { type: 'user', message: { content: [{ type: 'text', text: 'deuxième' }] } },
    { type: 'assistant', message: { content: [{ type: 'text', text: 'Réponse 2.' }] } },
  ]
  const out: { question: string; answer: string }[] = []
  for (const l of lines) foldLine(out, JSON.stringify(l))
  foldLine(out, '{"type":"user","mess')

  expect(out).toEqual([
    { question: 'première question', answer: 'Réponse 1.' },
    { question: 'deuxième', answer: 'Réponse 2.' },
  ])
})

test('a continued conversation keeps each question once', () => {
  const before = [
    { question: 'a', answer: 'A' },
    { question: 'b', answer: '' },
  ]
  const after = [
    { question: 'b', answer: 'B' },
    { question: 'c', answer: '' },
    { question: 'c, en fait', answer: 'C' },
  ]

  expect(join(before, after)).toEqual([
    { question: 'a', answer: 'A' },
    { question: 'b', answer: 'B' },
    { question: 'c, en fait', answer: 'C' },
  ])
})
