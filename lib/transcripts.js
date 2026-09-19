// Walks Claude Code session transcripts and yields one record per human prompt:
// what was typed, what came just before, which skills were already loaded in
// the session, and which the assistant loaded in that turn.

import { createReadStream } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { join } from 'node:path';

const stripReminders = t => t.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '').trim();

function textOf(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.filter(x => x && x.type === 'text').map(x => x.text ?? '').join('\n');
}

function isHumanPrompt(rec) {
  if (rec.type !== 'user' || rec.isMeta || rec.isSidechain) return false;
  const c = rec.message?.content;
  if (Array.isArray(c) && c.some(x => x && x.type === 'tool_result')) return false;
  const t = stripReminders(textOf(c));
  if (!t) return false;
  if (t.startsWith('<command-') || t.startsWith('<local-command') || t.startsWith('[Request interrupted')) return false;
  if (t.startsWith('<task-notification>') || t.includes('[SYSTEM NOTIFICATION') || t.startsWith('<local-command-caveat>')) return false;
  return true;
}

function slashCommand(rec) {
  const m = /<command-name>\/([\w:-]+)<\/command-name>/.exec(textOf(rec.message?.content));
  return m ? m[1] : null;
}

function skillLoadsIn(rec) {
  const out = [];
  const c = rec.message?.content;
  if (!Array.isArray(c)) return out;
  for (const x of c) {
    if (x?.type === 'tool_use' && x.name === 'Skill' && x.input?.skill) out.push(String(x.input.skill));
    if (x?.type === 'tool_result') {
      const s = typeof x.content === 'string' ? x.content : JSON.stringify(x.content ?? '');
      const m = /Launching skill: ([\w:-]+)/.exec(s);
      if (m) out.push(m[1]);
    }
  }
  return out;
}

async function* records(file) {
  const rl = createInterface({ input: createReadStream(file, { encoding: 'utf8' }), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line) continue;
    try { yield JSON.parse(line); } catch { /* a partial last line */ }
  }
}

export async function listSessions(projectsDir, { sinceMs = 0 } = {}) {
  const out = [];
  let dirs;
  try { dirs = await readdir(projectsDir, { withFileTypes: true }); } catch { return out; }
  for (const d of dirs) {
    if (!d.isDirectory()) continue;
    const dir = join(projectsDir, d.name);
    let files;
    try { files = await readdir(dir); } catch { continue; }
    for (const f of files) {
      if (!f.endsWith('.jsonl')) continue;
      const p = join(dir, f);
      const st = await stat(p);
      if (st.mtimeMs < sinceMs) continue;
      out.push({ path: p, project: d.name, session: f.replace(/\.jsonl$/, ''), mtimeMs: st.mtimeMs, size: st.size });
    }
  }
  return out.sort((a, b) => b.mtimeMs - a.mtimeMs);
}

/**
 * One turn per human prompt. `loadedBefore` is what any earlier turn loaded
 * (still in context unless the session compacted). `loadedNow` is what this
 * turn loaded, including a slash command typed as the prompt itself.
 */
export async function* turns(session) {
  let cur = null;
  const loadedBefore = new Set();
  const seenText = new Set();
  let lastAssistant = '';
  const finish = () => {
    if (!cur) return null;
    const t = cur;
    t.loadedNow = [...new Set(t.loadedNow)];
    for (const s of t.loadedNow) loadedBefore.add(s);
    cur = null;
    return t;
  };
  for await (const rec of records(session.path)) {
    if (rec.type === 'user' && !rec.isSidechain) {
      const cmd = slashCommand(rec);
      if (cmd) {
        if (cur) cur.loadedNow.push(cmd); else loadedBefore.add(cmd);
        continue;
      }
      if (isHumanPrompt(rec)) {
        const text = stripReminders(textOf(rec.message?.content));
        // The same prompt can be recorded twice (queued, then delivered); judge it once.
        if (seenText.has(text)) continue;
        seenText.add(text);
        const done = finish();
        if (done) yield done;
        cur = {
          project: session.project,
          session: session.session,
          uuid: rec.uuid,
          timestamp: rec.timestamp,
          cwd: rec.cwd,
          text,
          recent: lastAssistant.slice(-400),
          loadedBefore: [...loadedBefore],
          loadedNow: [],
        };
        continue;
      }
      if (cur) cur.loadedNow.push(...skillLoadsIn(rec));
      continue;
    }
    if (rec.type === 'assistant' && !rec.isSidechain) {
      const t = textOf(rec.message?.content);
      if (t) lastAssistant = t;
      if (cur) cur.loadedNow.push(...skillLoadsIn(rec));
    }
  }
  const done = finish();
  if (done) yield done;
}
