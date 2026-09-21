import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { parseFrontmatter, parseListing, readRoster, sameSkill } from '../lib/roster.js';
import { CHUNK, NONE, buildRank, buildVerify, readRank, suggest } from '../lib/scout.js';
import { turns } from '../lib/transcripts.js';

test('frontmatter: folded description joins into one line', () => {
  const { fields, body } = parseFrontmatter('---\nname: x\ndescription: >\n  Line one\n  line two\n---\n# Body\ntext');
  assert.equal(fields.name, 'x');
  assert.equal(fields.description, 'Line one line two');
  assert.match(body, /^# Body/);
});

test('roster: reads user, project and newest plugin version, dedupes by name', async () => {
  const files = {
    '/h/.claude/skills/a/SKILL.md': '---\nname: a\ndescription: does a\n---\nA body',
    '/h/.claude/skills/nodesc/SKILL.md': '---\nname: nodesc\n---\n',
    '/w/.claude/skills/a/SKILL.md': '---\nname: a\ndescription: project a\n---\n',
    '/h/.claude/plugins/cache/m/p/1.9.0/skills/s/SKILL.md': '---\nname: s\ndescription: old\n---\n',
    '/h/.claude/plugins/cache/m/p/1.10.0/skills/s/SKILL.md': '---\nname: s\ndescription: new\n---\n',
  };
  const dirs = {
    '/w/.claude/skills': ['a'], '/h/.claude/skills': ['a', 'nodesc'], '/h/.claude/plugins/cache': ['m'],
    '/h/.claude/plugins/cache/m': ['p'], '/h/.claude/plugins/cache/m/p': ['1.9.0', '1.10.0'],
    '/h/.claude/plugins/cache/m/p/1.10.0/skills': ['s'], '/h/.claude/plugins/cache/m/p/1.9.0/skills': ['s'],
  };
  const fs = {
    list: async p => (dirs[p] ?? []).map(name => ({ name, kind: 'dir' })),
    read: async p => { if (!(p in files)) throw new Error('missing'); return files[p]; },
    exists: async p => p in files,
  };
  const r = await readRoster(fs, { home: '/h', cwd: '/w' });
  assert.deepEqual(r.map(s => [s.name, s.description]), [['a', 'project a'], ['p:s', 'new']]);
});

test('sameSkill: plugin prefix is optional', () => {
  assert.ok(sameSkill('frontend-design:frontend-design', 'frontend-design'));
  assert.ok(!sameSkill('a', 'b'));
});

test('rank request carries every skill plus a none option and three gates', () => {
  const body = buildRank([{ name: 'a', description: 'd' }], 'do it', '');
  assert.deepEqual(Object.keys(body.questions.which.criteria), ['a', NONE]);
  assert.equal(Object.keys(body.questions).length, 4);
  const rank = readRank({ which: { choice: 'a', probabilities: { a: 0.7, [NONE]: 0.3 }, confidence: 0.4 }, gate_acts: { noul: 0.9 }, gate_procedure: { noul: 0.6 }, gate_prose: { noul: 0.9 } });
  assert.equal(rank.ranked[0][0], 'a');
  assert.ok(Math.abs(rank.gate - (0.9 + 0.6 + 0.1) / 3) < 1e-9);
});

test('suggest: gate below threshold means one call and no suggestion', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push(JSON.parse(init.body));
    return { ok: true, status: 200, text: JSON.stringify({ answers: { which: { choice: 'a', probabilities: { a: 0.9 } }, gate_acts: { noul: 0.1 }, gate_procedure: { noul: 0.1 }, gate_prose: { noul: 0.9 } }, usage: { input_tokens: 10, output_tokens: 1 } }) };
  };
  const r = await suggest({ fetchImpl, key: 'k', roster: [{ name: 'a', description: 'd', excerpt: 'x' }], request: 'hello there friend' });
  assert.equal(calls.length, 1);
  assert.equal(r.suggestion, null);
});

test('suggest: verify call names the winner and can reject it on fit', async () => {
  let n = 0;
  const fetchImpl = async (url, init) => {
    n++;
    const body = JSON.parse(init.body);
    if (n === 1) return { ok: true, status: 200, text: JSON.stringify({ answers: { which: { choice: 'a', probabilities: { a: 0.6, b: 0.3, [NONE]: 0.1 } }, gate_acts: { noul: 0.9 }, gate_procedure: { noul: 0.9 }, gate_prose: { noul: 0.1 } }, usage: {} }) };
    assert.deepEqual(body.state.candidates.map(c => c.name), ['a', 'b']);
    return { ok: true, status: 200, text: JSON.stringify({ answers: { which: { choice: 'a', probabilities: { a: 0.8 } }, fits_0: { noul: 0.2 }, fits_1: { noul: 0.1 } }, usage: {} }) };
  };
  const roster = [{ name: 'a', description: 'd', excerpt: 'x' }, { name: 'b', description: 'e', excerpt: 'y' }];
  const r = await suggest({ fetchImpl, key: 'k', roster, request: 'please review my blog post draft' });
  assert.equal(n, 2);
  assert.equal(r.suggestion, null, 'fit 0.2 is under the 0.3 threshold');
  const r2 = await suggest({ fetchImpl: async (u, i) => { const b = JSON.parse(i.body); return b.state.candidates ? { ok: true, status: 200, text: JSON.stringify({ answers: { which: { choice: 'a', probabilities: { a: 0.8 } }, fits_0: { noul: 0.7 }, fits_1: { noul: 0.1 } }, usage: {} }) } : { ok: true, status: 200, text: JSON.stringify({ answers: { which: { choice: 'a', probabilities: { a: 0.6, b: 0.3 } }, gate_acts: { noul: 0.9 }, gate_procedure: { noul: 0.9 }, gate_prose: { noul: 0.1 } }, usage: {} }) }; }, key: 'k', roster, request: 'please review my blog post draft' });
  assert.equal(r2.suggestion, 'a');
});

test('verify request exposes instructions, not just names', () => {
  const body = buildVerify([{ name: 'a', description: 'd', excerpt: 'Step one: read the file.' }], 'req', '');
  assert.match(body.questions.which.criteria.a, /Step one/);
  assert.equal(body.questions.fits_0.type, 'noul');
});

test('listing: wrapped descriptions and plugin names parse back into a roster', () => {
  const r = parseListing('- a: does a\n  and more of a\n- p:s: plugin skill\n- b: does b');
  assert.deepEqual(r, [{ name: 'a', description: 'does a and more of a' }, { name: 'p:s', description: 'plugin skill' }, { name: 'b', description: 'does b' }]);
});

test('suggest: a roster past the Choice cap is ranked in chunks, then verified once', async () => {
  const roster = Array.from({ length: CHUNK + 5 }, (_, i) => ({ name: `s${i}`, description: `skill ${i}`, excerpt: 'x' }));
  const sizes = [];
  const fetchImpl = async (url, init) => {
    const body = JSON.parse(init.body);
    if (body.state.candidates) {
      return { ok: true, status: 200, text: JSON.stringify({ answers: { which: { choice: body.state.candidates[0].name, probabilities: {} }, fits_0: { noul: 0.9 } }, usage: {} }) };
    }
    const names = Object.keys(body.questions.which.criteria);
    sizes.push(names.length);
    const first = names[0];
    return { ok: true, status: 200, text: JSON.stringify({ answers: { which: { choice: first, probabilities: { [first]: 0.7, [NONE]: 0.3 } }, gate_acts: { noul: 0.9 }, gate_procedure: { noul: 0.9 }, gate_prose: { noul: 0.1 } }, usage: { input_tokens: 5 } }) };
  };
  const r = await suggest({ fetchImpl, key: 'k', roster, request: 'a request long enough to judge' });
  assert.deepEqual(sizes, [CHUNK + 1, 6], 'two rank calls, each with its own none option');
  assert.equal(r.usage.calls, 3);
  assert.equal(r.usage.input, 10);
  assert.ok(['s0', `s${CHUNK}`].includes(r.suggestion));
});

test('transcripts: the session roster and the mod line come from attachment records', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'scout-'));
  const rec = o => JSON.stringify({ uuid: Math.random().toString(36).slice(2), timestamp: '2026-09-21T00:00:00Z', ...o });
  const lines = [
    rec({ type: 'attachment', attachment: { type: 'skill_listing', isInitial: true, skillCount: 2, names: ['a', 'b'], content: '- a: does a\n- b: does b' } }),
    rec({ type: 'user', message: { role: 'user', content: 'first prompt long enough' } }),
    rec({ type: 'attachment', attachment: { type: 'hook_additional_context', content: ['<skill_relevance>\nRelevant to this request: a. Load it with the Skill tool before answering. Ignore this if it does not fit what the user actually asked for.\n</skill_relevance>'] } }),
    rec({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', name: 'Skill', input: { skill: 'a' } }] } }),
    rec({ type: 'attachment', attachment: { type: 'skill_listing', isInitial: false, skillCount: 1, names: ['c'], content: '- c: does c' } }),
    rec({ type: 'user', message: { role: 'user', content: 'second prompt long enough <skill_relevance>\nRelevant to this request: c.\n</skill_relevance>' } }),
    rec({ type: 'user', message: { role: 'user', content: '<command-name>/c</command-name>' } }),
  ];
  const p = join(dir, 's.jsonl');
  await writeFile(p, lines.join('\n') + '\n');
  const out = [];
  for await (const t of turns({ path: p, project: 'x', session: 's' }, { isSkill: () => false })) out.push(t);
  assert.equal(out.length, 2);
  assert.deepEqual(out[0].roster.map(s => s.name), ['a', 'b']);
  assert.equal(out[0].suggested, 'a');
  assert.deepEqual(out[0].loadedNow, ['a']);
  assert.deepEqual(out[1].roster.map(s => s.name), ['a', 'b', 'c']);
  assert.equal(out[1].suggested, 'c');
  assert.equal(out[1].text, 'second prompt long enough', 'the mod line is not part of the prompt');
  assert.deepEqual(out[1].loadedNow, ['c'], 'a slash command counts as a load when the session listing knows the skill');
});

test('transcripts: turns, loads, slash commands, duplicates and notifications', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'scout-'));
  const rec = (type, role, content, extra = {}) => JSON.stringify({ type, message: { role, content }, uuid: Math.random().toString(36).slice(2), timestamp: '2026-09-19T00:00:00Z', ...extra });
  const lines = [
    rec('user', 'user', 'first prompt long enough'),
    rec('assistant', 'assistant', [{ type: 'text', text: 'ok' }, { type: 'tool_use', name: 'Skill', input: { skill: 'frontend-design' } }]),
    rec('user', 'user', [{ type: 'tool_result', content: 'Launching skill: frontend-design' }]),
    rec('user', 'user', 'second prompt long enough'),
    rec('user', 'user', 'second prompt long enough'),
    rec('user', 'user', '<command-name>/commit-helper</command-name>'),
    rec('user', 'user', '<command-name>/compact</command-name>'),
    rec('user', 'user', '<task-notification>ignore me</task-notification>'),
    rec('user', 'user', 'sidechain prompt here', { isSidechain: true }),
    rec('user', 'user', 'third prompt long enough'),
  ];
  const p = join(dir, 's.jsonl');
  await writeFile(p, lines.join('\n') + '\n');
  const out = [];
  for await (const t of turns({ path: p, project: 'x', session: 's' }, { isSkill: n => n !== 'compact' })) out.push(t);
  assert.deepEqual(out.map(t => t.text), ['first prompt long enough', 'second prompt long enough', 'third prompt long enough']);
  assert.deepEqual(out[0].loadedNow, ['frontend-design']);
  assert.deepEqual(out[1].loadedBefore, ['frontend-design']);
  assert.deepEqual(out[1].loadedNow, ['commit-helper']);
  assert.deepEqual(out[2].loadedBefore.sort(), ['commit-helper', 'frontend-design']);
});
