import { describe, expect, mock, test } from 'claude-code/testing'
import type { PromptSubmitInput, SessionStartInput } from 'claude-code'

const session: SessionStartInput = { surface: 'terminal', isInteractive: true, cwd: '/work' }
const prompt = (text: string): PromptSubmitInput => ({ text, wait: false, origin: { kind: 'composer' } })

const SKILL = '---\nname: frontend-design\ndescription: Build polished web screens that follow the design system.\n---\nRead the design tokens first.'

function world(on: Parameters<Parameters<typeof test>[1]>[1], fetchBodies: string[], answers: object[]) {
  mock.store(on, {})
  mock.env(on, { HOME: '/h', TYPESAFE_API_KEY: 'k' })
  on('session.cwd', () => ({ value: '/work' }))
  on('fs.list', ($, e) => ({ value: e.path === '/h/.claude/skills' ? [{ name: 'frontend-design', kind: 'dir', size: 0, isLink: false }] : [] }))
  on('fs.exists', ($, e) => ({ value: e.path === '/h/.claude/skills/frontend-design/SKILL.md' }))
  on('fs.read', () => ({ value: SKILL }))
  mock.clock(on)
  on('ui.log', () => ({ value: undefined }))
  on('ui.status', () => ({ value: undefined }))
  on('http.fetch', ($, e) => {
    fetchBodies.push(String(e.init?.body ?? ''))
    const body = answers.shift() ?? {}
    return { value: { status: 200, ok: true, headers: {}, text: JSON.stringify(body) } }
  })
  on('session.start', ($, e) => ({ cwd: e.cwd }))
}

const rankYes = { answers: { which: { choice: 'frontend-design', probabilities: { 'frontend-design': 0.8, __none__: 0.2 }, confidence: 0.6 }, gate_acts: { noul: 0.9 }, gate_procedure: { noul: 0.9 }, gate_prose: { noul: 0.1 } }, usage: {} }
const verifyYes = { answers: { which: { choice: 'frontend-design', probabilities: { 'frontend-design': 0.9 } }, fits_0: { noul: 0.8 } }, usage: {} }
const rankNo = { answers: { which: { choice: '__none__', probabilities: { 'frontend-design': 0.2, __none__: 0.8 } }, gate_acts: { noul: 0.1 }, gate_procedure: { noul: 0.1 }, gate_prose: { noul: 0.9 } }, usage: {} }

describe('jev-skill-scout', () => {
  test('attaches one context line naming the skill Jev confirmed', async ($, on) => {
    const bodies: string[] = []
    world(on, bodies, [rankYes, verifyYes])
    let entered: PromptSubmitInput | null = null
    on('prompt.submit', ($, e) => { entered = e; return { text: e.text } })

    await $.session.start(session)
    await $.prompt.submit(prompt('make this reddit reply sound like me'))

    expect(bodies.length).toBe(2)
    expect(JSON.parse(bodies[0]!).questions.which.criteria).toHaveProperty('frontend-design')
    expect(entered!.context?.[0]).toContain('Relevant to this request: frontend-design')
  })

  test('leaves the prompt alone when the gate says no skill is needed', async ($, on) => {
    const bodies: string[] = []
    world(on, bodies, [rankNo])
    let entered: PromptSubmitInput | null = null
    on('prompt.submit', ($, e) => { entered = e; return { text: e.text } })

    await $.session.start(session)
    await $.prompt.submit(prompt('what does this error mean, roughly'))

    expect(bodies.length).toBe(1)
    expect(entered!.context ?? []).toEqual([])
  })

  test('skips slash commands and short prompts without a request', async ($, on) => {
    const bodies: string[] = []
    world(on, bodies, [])
    on('prompt.submit', ($, e) => ({ text: e.text }))

    await $.session.start(session)
    await $.prompt.submit(prompt('/compact'))
    await $.prompt.submit(prompt('ok'))

    expect(bodies.length).toBe(0)
  })

  test('enters the prompt once even when the request fails', async ($, on) => {
    mock.store(on, {})
    mock.env(on, { HOME: '/h', TYPESAFE_API_KEY: 'k' })
    on('session.cwd', () => ({ value: '/work' }))
    on('fs.list', () => ({ value: [{ name: 'frontend-design', kind: 'dir', size: 0, isLink: false }] }))
    on('fs.exists', () => ({ value: true }))
    on('fs.read', () => ({ value: SKILL }))
    mock.clock(on)
    on('ui.log', () => ({ value: undefined }))
    on('ui.status', () => ({ value: undefined }))
    on('http.fetch', () => ({ value: { status: 500, ok: false, headers: {}, text: 'down' } }))
    on('session.start', ($, e) => ({ cwd: e.cwd }))
    let entered = 0
    on('prompt.submit', ($, e) => { entered++; return { text: e.text } })

    await $.session.start(session)
    await $.prompt.submit(prompt('draft the launch post for the repo'))

    expect(entered).toBe(1)
  })
})
