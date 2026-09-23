import type { Register } from 'claude-code'

import { readRoster } from '../lib/roster.js'
import { contextLine, suggest } from '../lib/scout.js'

type Skill = { name: string; description: string; excerpt: string; path: string; source: string }
type Init = { method?: string; headers?: Record<string, string>; body?: string }
type Suggestion = {
  suggestion: string | null
  verify: { fits: Record<string, number> } | null
  ms: number
}
type Options = {
  apiKey?: string
  enabled?: boolean
  gateThreshold?: number
  fitsThreshold?: number
  timeoutMs?: number
  model?: string
  quiet?: boolean
  shadow?: boolean
}

const ROSTER_KEY = 'roster.v1'
const ROSTER_TTL_MS = 10 * 60 * 1000

export const register: Register = (on, options) => {
  const opt = (options ?? {}) as Options
  const enabled = opt.enabled !== false

  on('session.start', async ($, e, next) => {
    const r = await next(e)
    if (!enabled) return r
    const home = await $.env.get('HOME')
    if (!home) return r
    const roster = await readRoster(
      { list: p => $.fs.list(p), read: p => $.fs.read(p), exists: p => $.fs.exists(p) },
      { home, cwd: e.cwd },
    )
    await $.store.set(ROSTER_KEY, { at: Date.now(), cwd: e.cwd, skills: roster })
    if (!opt.quiet) $.ui.log(`jev-skill-scout: ${roster.length} skills indexed`)
    return r
  })

  on('prompt.submit', async ($, e, next) => {
    const typed = e.origin.kind === 'composer' || e.origin.kind === 'bridge'
    if (!enabled || !typed || e.text.length < 12 || e.text.startsWith('/')) return next(e)
    const key = opt.apiKey || (await $.env.get('TYPESAFE_API_KEY')) || (await $.env.get('TYPESAFE_KEY'))
    if (!key) return next(e)
    const cached = (await $.store.get(ROSTER_KEY)) as { at: number; cwd: string; skills: Skill[] } | undefined
    let roster = cached?.skills ?? []
    if (!cached || Date.now() - cached.at > ROSTER_TTL_MS) {
      const home = await $.env.get('HOME')
      const cwd = await $.session.cwd()
      if (home) {
        roster = await readRoster(
          { list: p => $.fs.list(p), read: p => $.fs.read(p), exists: p => $.fs.exists(p) },
          { home, cwd },
        )
        await $.store.set(ROSTER_KEY, { at: Date.now(), cwd, skills: roster })
      }
    }
    if (!roster.length) return next(e)

    const started = await $.clock.now()
    let result: Suggestion | null = null
    try {
      result = (await Promise.race([
        suggest({
          // The engine's init has no abort signal; the race below is the timeout.
          fetchImpl: (url: string, init: Init) => $.http.fetch(url, { method: init.method, headers: init.headers, body: init.body }),
          key,
          roster,
          request: e.text,
          options: {
            model: opt.model,
            gateThreshold: opt.gateThreshold,
            fitsThreshold: opt.fitsThreshold,
            timeoutMs: opt.timeoutMs ?? 4000,
          },
        }),
        $.clock.sleep(opt.timeoutMs ?? 4000).then(() => null),
      ])) as Suggestion | null
    } catch (err) {
      if (!opt.quiet) $.ui.log(`jev-skill-scout: off for this turn (${String(err).slice(0, 120)})`)
      return next(e)
    }
    const ms = (await $.clock.now()) - started
    if (!result) {
      if (!opt.quiet) $.ui.status(`jev-skill-scout: no answer in ${ms} ms, turn left alone`)
      return next(e)
    }
    if (!result.suggestion) {
      if (!opt.quiet) $.ui.status(`jev-skill-scout: no skill (${ms} ms)`)
      return next(e)
    }
    const fit = result.verify?.fits?.[result.suggestion] ?? 0
    const shadow = opt.shadow || (await $.env.get('JEV_SKILL_SCOUT_SHADOW')) === '1'
    if (shadow) {
      $.ui.status(`jev-skill-scout (shadow): would suggest ${result.suggestion} (fit ${fit.toFixed(2)}, ${ms} ms)`)
      return next(e)
    }
    if (!opt.quiet) $.ui.status(`jev-skill-scout: ${result.suggestion} (fit ${fit.toFixed(2)}, ${ms} ms)`)
    return next({ ...e, context: [...(e.context ?? []), contextLine(result.suggestion)] })
  }).catch(($, e, next) => {
    // Core has a side effect on prompt.submit: enter the prompt exactly once.
    if (next.called) return undefined
    return next(e)
  })
}
