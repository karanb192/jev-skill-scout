// The judgment. Two TypeSafe requests at most, following the skill-suggestion
// cookbook (https://docs.typesafe.ai/cookbooks/skill_suggestion): rank the whole
// roster and gate the turn, then re-read the top few properly and allow a reject.
// Pure: the caller supplies fetch, so the mod and the audit make the same calls.

export const NONE = '__none__';
export const ENDPOINT = 'https://api.typesafe.ai/v1/systemone';

export const DEFAULTS = {
  model: 'jev-latest',
  shortlist: 3,
  gateThreshold: 0.3,   // mean of the oriented gate nouls; below it, no skill
  fitsThreshold: 0.3,   // the winner's "really fits" noul; below it, no skill
  descriptionChars: 400,
  excerptChars: 700,
  contextChars: 400,
  timeoutMs: 4000,
  minPromptChars: 12,
};

const GATES = {
  acts: 'Does `request` ask the agent to do something with the user\'s files, repositories, accounts, sites, documents or data, rather than only answer from general knowledge?',
  procedure: 'Would a careful agent answer `request` better by following a specific written procedure, checklist or house style, rather than by general skill alone?',
  prose: 'Can `request` be fully satisfied by a short reply in prose, with no tools, no files and no procedure?',
};
const INVERTED = new Set(['prose']);

const cut = (s, n) => {
  const flat = String(s ?? '').replace(/\s+/g, ' ').trim();
  return flat.length <= n ? flat : `${flat.slice(0, n - 3).trimEnd()}...`;
};

export function buildRank(roster, request, recent, o = DEFAULTS) {
  const criteria = {};
  for (const s of roster) criteria[s.name] = cut(s.description, o.descriptionChars);
  criteria[NONE] = 'None of the skills above is what this request needs. Also the answer for small talk, a question answerable from what is already on screen, or a small direct edit that needs no procedure.';
  const questions = {
    which: {
      type: 'choice',
      instructions: 'Which single skill should the agent read before answering `request`? Judge each skill only by what its description says it is for, and prefer the skill whose trigger conditions the request matches most specifically.',
      criteria,
    },
  };
  for (const [k, text] of Object.entries(GATES)) questions[`gate_${k}`] = { type: 'noul', instructions: text };
  return {
    model: o.model,
    state: { request: cut(request, 4000), recent_context: cut(recent, o.contextChars) },
    questions,
  };
}

export function readRank(answers) {
  const which = answers.which;
  const ranked = Object.entries(which.probabilities ?? {}).sort((a, b) => b[1] - a[1]);
  const gates = {};
  let sum = 0, n = 0;
  for (const [k] of Object.entries(GATES)) {
    const v = answers[`gate_${k}`]?.noul;
    if (typeof v !== 'number') continue;
    gates[k] = v;
    sum += INVERTED.has(k) ? 1 - v : v;
    n++;
  }
  return { ranked, gate: n ? sum / n : 0, gates, confidence: which.confidence ?? null };
}

export function buildVerify(candidates, request, recent, o = DEFAULTS) {
  const criteria = {};
  for (const c of candidates) criteria[c.name] = `${cut(c.description, o.descriptionChars)} Instructions begin: ${cut(c.excerpt, o.excerptChars)}`;
  criteria[NONE] = 'None of these skills should be loaded for this request.';
  const questions = {
    which: {
      type: 'choice',
      instructions: 'Now that each candidate skill\'s real instructions are visible, which one should the agent load before answering `request`?',
      criteria,
    },
  };
  candidates.forEach((c, i) => {
    questions[`fits_${i}`] = {
      type: 'noul',
      instructions: `Would loading skill \`candidates[${i}].name\` change how the agent handles \`request\` for the better, judged by the skill's own instructions, not its name?`,
      criteria: { true: 'The skill\'s instructions cover this request and following them would change the work.', false: 'Wrong domain, or the request would be handled the same way without it.' },
    };
  });
  return {
    model: o.model,
    state: {
      request: cut(request, 4000),
      recent_context: cut(recent, o.contextChars),
      candidates: candidates.map(c => ({ name: c.name, description: cut(c.description, o.descriptionChars), instructions: cut(c.excerpt, o.excerptChars) })),
    },
    questions,
  };
}

export function readVerify(answers, candidates) {
  const which = answers.which;
  const fits = {};
  candidates.forEach((c, i) => { fits[c.name] = answers[`fits_${i}`]?.noul ?? 0; });
  return { winner: which.choice, probabilities: which.probabilities ?? {}, confidence: which.confidence ?? null, fits };
}

/**
 * Ask Jev. `fetchImpl(url, init)` resolves `{ ok, status, text }` (the engine's
 * $.http.fetch and a wrapper over global fetch both fit).
 */
export async function ask(fetchImpl, key, body, timeoutMs = DEFAULTS.timeoutMs, retries = 0) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await askOnce(fetchImpl, key, body, timeoutMs);
    } catch (e) {
      const msg = String(e?.message ?? e);
      const retryable = /aborted|429|50\d|fetch failed|ECONN|ETIMEDOUT/i.test(msg);
      if (!retryable || attempt >= retries) throw e;
      await new Promise(r => setTimeout(r, 500 * (attempt + 1)));
    }
  }
}

async function askOnce(fetchImpl, key, body, timeoutMs) {
  const controller = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
  try {
    const r = await fetchImpl(ENDPOINT, {
      method: 'POST',
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller?.signal,
    });
    const text = typeof r.text === 'function' ? await r.text() : r.text;
    if (!r.ok) throw new Error(`typesafe ${r.status}: ${String(text).slice(0, 200)}`);
    return JSON.parse(text);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * The whole judgment for one request. Returns what the mod would attach and
 * everything the audit needs to explain it.
 */
export async function suggest({ fetchImpl, key, roster, request, recent = '', options = {} }) {
  const o = { ...DEFAULTS, ...options };
  const t0 = Date.now();
  const rankBody = buildRank(roster, request, recent, o);
  const r1 = await ask(fetchImpl, key, rankBody, o.timeoutMs, o.retries ?? 0);
  const rank = readRank(r1.answers);
  const usage = { input: r1.usage?.input_tokens ?? 0, output: r1.usage?.output_tokens ?? 0, calls: 1 };
  const out = { suggestion: null, rank, verify: null, usage, ms: 0, stage: 'gate' };
  if (rank.gate < o.gateThreshold) { out.ms = Date.now() - t0; return out; }
  const short = rank.ranked.filter(([n]) => n !== NONE).slice(0, o.shortlist).map(([n]) => roster.find(s => s.name === n)).filter(Boolean);
  if (!short.length) { out.ms = Date.now() - t0; return out; }
  const r2 = await ask(fetchImpl, key, buildVerify(short, request, recent, o), o.timeoutMs, o.retries ?? 0);
  const verify = readVerify(r2.answers, short);
  usage.input += r2.usage?.input_tokens ?? 0;
  usage.output += r2.usage?.output_tokens ?? 0;
  usage.calls = 2;
  out.verify = verify;
  out.stage = 'verify';
  if (verify.winner && verify.winner !== NONE && (verify.fits[verify.winner] ?? 0) >= o.fitsThreshold) out.suggestion = verify.winner;
  out.ms = Date.now() - t0;
  return out;
}

export function contextLine(name) {
  return `<skill_relevance>\nRelevant to this request: ${name}. Load it with the Skill tool before answering. Ignore this if it does not fit what the user actually asked for.\n</skill_relevance>`;
}
