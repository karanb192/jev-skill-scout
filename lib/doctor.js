// Scores a skill description against the real prompts in an audit: the ones
// that loaded the skill (it should match those) and the ones where Jev picked
// it but the turn loaded something else (it should not). One Noul per prompt,
// all in one request, so a rewrite is judged on your own history for a cent.

import { ask } from './scout.js';
import { sameSkill } from './roster.js';

export const BATCH = 40;

export function gather(cases, skill, { limit = BATCH } = {}) {
  const loaded = [];
  const suspect = [];
  const missed = [];
  for (const c of cases) {
    if (!c.text || c.category === 'trivial') continue;
    if (c.loadedNow.some(n => sameSkill(n, skill))) loaded.push(c);
    else if (c.suggestion && sameSkill(c.suggestion, skill)) {
      if (c.category === 'disagree') suspect.push(c);
      else if (c.category === 'miss') missed.push(c);
    }
  }
  const pick = (arr, n) => arr.sort((a, b) => (b.fit ?? 0) - (a.fit ?? 0)).slice(0, n);
  return {
    loaded: pick(loaded, limit),
    suspect: pick(suspect, limit),
    missed: pick(missed, limit),
    totals: { loaded: loaded.length, suspect: suspect.length, missed: missed.length },
  };
}

export function buildScore(description, prompts, model) {
  const questions = {};
  prompts.forEach((p, i) => {
    questions[`fit_${i}`] = {
      type: 'noul',
      instructions: `Would a skill whose description is \`description\` be the right one for the agent to load before answering \`prompts[${i}].text\`? Judge by the description alone.`,
    };
  });
  return {
    model,
    state: { description, prompts: prompts.map(p => ({ text: String(p.text).replace(/\s+/g, ' ').slice(0, 600) })) },
    questions,
  };
}

function readScore(answers, n) {
  const out = [];
  for (let i = 0; i < n; i++) out.push(answers[`fit_${i}`]?.noul ?? 0);
  return out;
}

const mean = xs => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

/**
 * For each description, one request: every gathered prompt scored. Returns
 * per-description means for the three groups and the per-prompt numbers.
 */
export async function score({ fetchImpl, key, descriptions, groups, model = 'jev-latest', timeoutMs = 20000 }) {
  const prompts = [...groups.loaded, ...groups.missed, ...groups.suspect];
  const out = [];
  for (const [label, description] of descriptions) {
    const t0 = Date.now();
    const r = await ask(fetchImpl, key, buildScore(description, prompts, model), timeoutMs, 2);
    const p = readScore(r.answers, prompts.length);
    let i = 0;
    const take = arr => arr.map(() => p[i++]);
    const loaded = take(groups.loaded), missed = take(groups.missed), suspect = take(groups.suspect);
    out.push({
      label,
      description,
      loaded: mean(loaded),
      missed: mean(missed),
      suspect: mean(suspect),
      perPrompt: { loaded, missed, suspect },
      ms: Date.now() - t0,
      input: r.usage?.input_tokens ?? 0,
    });
  }
  return { prompts, results: out };
}

export function render(skill, groups, scored) {
  const pct = x => `${Math.round(100 * x)}%`;
  const lines = [];
  lines.push('');
  lines.push(`jev-skill-scout doctor: ${skill}`);
  lines.push(`  ${groups.totals.loaded} prompts loaded it (${groups.loaded.length} scored), ${groups.totals.missed} where Jev picked it and nothing loaded (${groups.missed.length} scored), ${groups.totals.suspect} where Jev picked it but the turn loaded another skill (${groups.suspect.length} scored).`);
  lines.push('');
  lines.push(`  ${'description'.padEnd(14)} ${'loaded it'.padStart(10)} ${'Jev missed'.padStart(11)} ${'suspect'.padStart(8)}   what you want`);
  lines.push(`  ${''.padEnd(14)} ${'high'.padStart(10)} ${'high'.padStart(11)} ${'low'.padStart(8)}`);
  for (const r of scored.results) {
    lines.push(`  ${r.label.padEnd(14)} ${pct(r.loaded).padStart(10)} ${pct(r.missed).padStart(11)} ${pct(r.suspect).padStart(8)}   ${r.input.toLocaleString('en-US')} tokens, ${r.ms} ms`);
  }
  lines.push('');
  lines.push('  "loaded it" is the mean probability the description matches prompts that really used the skill; "suspect" the same over prompts where the turn chose a different skill. A rewrite should raise the first two and drop the third.');
  const base = scored.results[0];
  const worst = base.perPrompt.loaded.map((v, i) => [v, groups.loaded[i]]).sort((a, b) => a[0] - b[0]).slice(0, 5);
  if (worst.length) {
    lines.push('');
    lines.push('  Prompts that loaded it and the current description matches least:');
    for (const [v, c] of worst) lines.push(`    ${pct(v).padStart(4)}  ${String(c.text).replace(/\s+/g, ' ').slice(0, 110)}`);
  }
  const fp = base.perPrompt.suspect.map((v, i) => [v, groups.suspect[i]]).sort((a, b) => b[0] - a[0]).slice(0, 5);
  if (fp.length) {
    lines.push('');
    lines.push('  Prompts where another skill was loaded and the current description still matches most:');
    for (const [v, c] of fp) lines.push(`    ${pct(v).padStart(4)}  ${String(c.text).replace(/\s+/g, ' ').slice(0, 90)}  (loaded ${c.loadedNow.join(', ')})`);
  }
  return lines.join('\n');
}
