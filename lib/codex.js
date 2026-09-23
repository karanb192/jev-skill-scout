// Codex CLI support: its session transcripts (~/.codex/sessions/**/*.jsonl)
// and its UserPromptSubmit hook, which takes JSON on stdin and can answer with
// additionalContext, the same line the Claude Code mod attaches.

import { createReadStream } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { join } from 'node:path';

import { sameSkill } from './roster.js';
import { contextLine } from './scout.js';
import { RELEVANCE_RE } from './transcripts.js';

const SKILL_PATH_RE = /\/skills\/(?:\.system\/)?([\w.-]+)\/SKILL\.md/g;

const textOf = content => (Array.isArray(content) ? content.filter(c => c && typeof c.text === 'string').map(c => c.text).join('\n') : typeof content === 'string' ? content : '');

/**
 * The `<skills_instructions>` block Codex shows the model: a roots table
 * (`r0` = path) and one `- name: description (file: r0/name/SKILL.md)` per skill.
 */
export function parseSkillsInstructions(text) {
  const roots = {};
  const skills = [];
  let pending = null;
  for (const raw of String(text ?? '').split('\n')) {
    const line = raw.trim();
    const root = /^- `(r\d+)` = `([^`]+)`/.exec(line);
    if (root) { roots[root[1]] = root[2]; continue; }
    const start = /^- ([^\s:]+): (.*)$/.exec(line);
    if (start) pending = { name: start[1], description: start[2] };
    else if (pending && line) pending.description += ` ${line}`;
    else continue;
    // Newer listings give `r0/name/SKILL.md` against a roots table; older ones an absolute path.
    const file = /\(file: ([^)]+)\)\s*$/.exec(pending.description);
    if (file) {
      pending.description = pending.description.slice(0, file.index).trim();
      const rel = /^(r\d+)\/(.+)$/.exec(file[1]);
      pending.path = rel ? `${roots[rel[1]] ?? rel[1]}/${rel[2]}` : file[1];
      skills.push(pending);
      pending = null;
    }
  }
  return { roots, skills };
}

export async function listCodexSessions(sessionsDir, { sinceMs = 0 } = {}) {
  const out = [];
  const walk = async dir => {
    let entries;
    try { entries = await readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = join(dir, e.name);
      if (e.isDirectory()) { await walk(p); continue; }
      if (!e.name.endsWith('.jsonl')) continue;
      const st = await stat(p);
      if (st.mtimeMs < sinceMs) continue;
      out.push({ path: p, project: '', session: e.name.replace(/\.jsonl$/, ''), mtimeMs: st.mtimeMs, size: st.size });
    }
  };
  await walk(sessionsDir);
  return out.sort((a, b) => b.mtimeMs - a.mtimeMs);
}

async function* records(file) {
  const rl = createInterface({ input: createReadStream(file, { encoding: 'utf8' }), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line) continue;
    try { yield [JSON.parse(line), line]; } catch { /* a partial last line */ }
  }
}

function loadsIn(line, roster) {
  const out = new Set();
  for (const s of roster ?? []) if (s.path && line.includes(s.path)) out.add(s.name);
  for (const m of line.matchAll(SKILL_PATH_RE)) out.add(m[1]);
  return [...out];
}

/**
 * One turn per human prompt, the same shape `transcripts.turns` yields for
 * Claude Code. Subagent threads are skipped whole. A skill load is a tool call
 * that reads the skill's SKILL.md; Codex has no Skill tool.
 */
export async function* codexTurns(session, { isSkill = () => true } = {}) {
  let cur = null;
  let roster = null;
  let cwd = '';
  let lastAssistant = '';
  const loadedBefore = new Set();
  const seenText = new Set();
  const known = name => isSkill(name) || (roster ?? []).some(s => sameSkill(s.name, name));
  const finish = () => {
    if (!cur) return null;
    const t = cur;
    t.loadedNow = [...new Set(t.loadedNow)].filter(known);
    for (const s of t.loadedNow) loadedBefore.add(s);
    cur = null;
    return t;
  };
  for await (const [rec, line] of records(session.path)) {
    const p = rec.payload ?? {};
    if (rec.type === 'session_meta') {
      if (p.source && typeof p.source === 'object' && p.source.subagent) return;
      cwd = p.cwd ?? '';
      session.project = cwd.replace(/\//g, '-');
      continue;
    }
    if (rec.type !== 'response_item') continue;
    if (p.type === 'message') {
      const text = textOf(p.content);
      if (p.role === 'developer') {
        const i = text.indexOf('<skills_instructions>');
        if (i >= 0) {
          const parsed = parseSkillsInstructions(text.slice(i)).skills;
          // An older listing format that does not parse must not become an empty roster.
          if (parsed.length) { roster = parsed; if (cur && !cur.roster) cur.roster = roster; }
        }
        const m = RELEVANCE_RE.exec(text);
        if (m && cur) cur.suggested = m[1];
        continue;
      }
      if (p.role === 'assistant') { if (text) lastAssistant = text; continue; }
      if (p.role !== 'user') continue;
      const m = RELEVANCE_RE.exec(text);
      const clean = text.replace(RELEVANCE_RE, '').trim();
      if (!clean || clean.startsWith('<') || clean.startsWith('# AGENTS.md')) { if (m && cur) cur.suggested = m[1]; continue; }
      if (seenText.has(clean)) continue;
      seenText.add(clean);
      const done = finish();
      if (done) yield done;
      cur = {
        project: session.project,
        session: session.session,
        uuid: p.id,
        timestamp: rec.timestamp,
        cwd,
        text: clean,
        recent: lastAssistant.slice(-400),
        loadedBefore: [...loadedBefore],
        loadedNow: [],
        roster,
        suggested: m ? m[1] : null,
      };
      continue;
    }
    if (cur && (p.type === 'custom_tool_call' || p.type === 'function_call' || p.type === 'local_shell_call')) {
      cur.loadedNow.push(...loadsIn(line, roster));
    }
  }
  const done = finish();
  if (done) yield done;
}

/** What the UserPromptSubmit hook prints when a skill is worth naming. */
export function hookOutput(name) {
  return JSON.stringify({ hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: contextLine(name) } });
}

/** The ~/.codex/hooks.json entry that runs the hook on every prompt. */
export function hookEntry(command, timeoutMs) {
  return { type: 'command', command, timeout: timeoutMs, statusMessage: 'jev-skill-scout: ranking your skills' };
}
