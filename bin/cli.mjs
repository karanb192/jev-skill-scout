#!/usr/bin/env node
// jev-skill-scout: audit your Claude Code transcripts for skills that should
// have loaded and did not. One command, one key, one HTML report.

import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, readdir, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';

import { readRoster, sameSkill } from '../lib/roster.js';
import { DEFAULTS, NONE, decide, suggest } from '../lib/scout.js';
import { listSessions, turns } from '../lib/transcripts.js';
import { html, summarize, terminal } from '../lib/report.js';

const HELP = `jev-skill-scout audit [options]

Replays every prompt in your Claude Code transcripts through TypeSafe's Jev
and reports the turns where a skill should have loaded and did not.

  --key <k>          TypeSafe API key (default: $TYPESAFE_API_KEY, then $TYPESAFE_KEY)
  --dir <path>       transcripts directory (default: ~/.claude/projects)
  --days <n>         only sessions touched in the last n days (default: all)
  --limit <n>        stop after n judged prompts (default: no limit)
  --project <text>   only projects whose folder name contains this text
  --concurrency <n>  parallel Jev requests (default: 8)
  --gate <p>         gate threshold (default ${DEFAULTS.gateThreshold})
  --fit <p>          fit threshold for the winner (default ${DEFAULTS.fitsThreshold})
  --out <dir>        output directory (default: ./skill-audit)
  --model <name>     Jev model (default ${DEFAULTS.model})
  --dry-run          count prompts and estimate cost; no requests
  --yes              skip the cost confirmation
  --no-cache         ignore cached judgments from earlier runs

jev-skill-scout roster       list the skills the audit would rank
`;

function parseArgs(argv) {
  const o = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) { o._.push(a); continue; }
    const k = a.slice(2);
    if (k === 'dry-run' || k === 'yes' || k === 'no-cache' || k === 'help') { o[k] = true; continue; }
    o[k] = argv[++i];
  }
  return o;
}

const nodeFs = {
  list: async p => (await readdir(p, { withFileTypes: true })).map(e => ({ name: e.name, kind: e.isDirectory() ? 'dir' : e.isSymbolicLink() ? 'other' : 'file' })),
  read: p => readFile(p, 'utf8'),
  exists: async p => { try { await stat(p); return true; } catch { return false; } },
};

async function fetchImpl(url, init) {
  const r = await fetch(url, init);
  return { ok: r.ok, status: r.status, text: await r.text() };
}

function ask(question) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(res => rl.question(question, a => { rl.close(); res(a.trim().toLowerCase()); }));
}

function categorize(t, sug) {
  if (sug === 'trivial') return 'trivial';
  if (sug === 'error') return 'error';
  const loadedNow = t.loadedNow;
  if (sug) {
    if (loadedNow.some(n => sameSkill(n, sug))) return 'hit';
    if (t.loadedBefore.some(n => sameSkill(n, sug))) return 'already-loaded';
    if (loadedNow.length) return 'disagree';
    return 'miss';
  }
  return loadedNow.length ? 'unsuggested-load' : 'quiet';
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = args._[0];
  if (args.help || !cmd || !['audit', 'roster'].includes(cmd)) { process.stdout.write(HELP); process.exit(cmd ? 1 : 0); }

  const home = homedir();
  const roster = await readRoster(nodeFs, { home, cwd: process.cwd() });
  if (cmd === 'roster') {
    for (const s of roster) process.stdout.write(`${s.name.padEnd(44)} ${s.source.padEnd(28)} ${s.description.slice(0, 80)}\n`);
    process.stdout.write(`\n${roster.length} skills\n`);
    return;
  }
  if (!roster.length) { console.error('No SKILL.md files found under ~/.claude/skills, ~/.claude/plugins/cache or ./.claude/skills.'); process.exit(1); }

  const key = args.key ?? process.env.TYPESAFE_API_KEY ?? process.env.TYPESAFE_KEY;
  const projectsDir = resolve(args.dir ?? join(home, '.claude', 'projects'));
  const outDir = resolve(args.out ?? 'skill-audit');
  const options = {
    model: args.model ?? DEFAULTS.model,
    timeoutMs: 20000,
    retries: 2,
    gateThreshold: args.gate ? Number(args.gate) : DEFAULTS.gateThreshold,
    fitsThreshold: args.fit ? Number(args.fit) : DEFAULTS.fitsThreshold,
  };
  const sinceMs = args.days ? Date.now() - Number(args.days) * 86400e3 : 0;
  const limit = args.limit ? Number(args.limit) : Infinity;
  const concurrency = Math.max(1, Number(args.concurrency ?? 8));

  let sessions = await listSessions(projectsDir, { sinceMs });
  if (args.project) sessions = sessions.filter(s => s.project.includes(args.project));
  if (!sessions.length) { console.error(`No transcripts found under ${projectsDir}.`); process.exit(1); }

  const all = [];
  const isSkill = name => roster.some(r => sameSkill(r.name, name));
  for (const s of sessions) for await (const t of turns(s, { isSkill })) all.push(t);
  const judgeable = all.filter(t => t.text.length >= DEFAULTS.minPromptChars);
  const rosterChars = roster.reduce((n, s) => n + Math.min(s.description.length, DEFAULTS.descriptionChars) + s.name.length + 4, 0);
  const estTokens = judgeable.reduce((n, t) => n + (rosterChars + Math.min(t.text.length, 4000) + 400) / 4, 0);
  const estCost = (estTokens * 1.6) / 1e6 * 0.042; // the second call runs on some turns

  console.error(`${sessions.length} sessions, ${all.length} human prompts, ${judgeable.length} long enough to judge, ${roster.length} skills.`);
  console.error(`Estimated ${Math.round(estTokens).toLocaleString()} input tokens for call 1, about $${estCost.toFixed(2)} in all.`);
  if (args['dry-run']) return;
  if (!key) { console.error('No TypeSafe key. Set TYPESAFE_API_KEY or pass --key. Keys: https://console.typesafe.ai/settings/keys'); process.exit(1); }
  if (!args.yes) {
    const a = await ask('Run it? [y/N] ');
    if (a !== 'y' && a !== 'yes') return;
  }

  await mkdir(outDir, { recursive: true });
  const cachePath = join(outDir, 'cache.json');
  const rosterHash = createHash('sha1').update(JSON.stringify(roster.map(s => [s.name, s.description, s.excerpt]))).digest('hex').slice(0, 10);
  let cache = {};
  if (!args['no-cache'] && existsSync(cachePath)) { try { cache = JSON.parse(await readFile(cachePath, 'utf8')); } catch { cache = {}; } }

  const cases = [];
  let judged = 0, done = 0, failed = 0;
  const started = Date.now();
  const queue = [...all];
  const worker = async () => {
    while (queue.length) {
      const t = queue.shift();
      const id = createHash('sha1').update(`${t.session}:${t.uuid ?? t.timestamp}`).digest('hex').slice(0, 12);
      const base = { id, project: t.project, session: t.session, timestamp: t.timestamp, text: t.text, recent: t.recent, loadedBefore: t.loadedBefore, loadedNow: t.loadedNow };
      if (t.text.length < DEFAULTS.minPromptChars) { cases.push({ ...base, category: 'trivial' }); continue; }
      if (judged >= limit) { continue; }
      judged++;
      const ck = `${id}:${rosterHash}:${options.model}`;
      let res = cache[ck];
      if (!res) {
        try {
          res = await suggest({ fetchImpl, key, roster, request: t.text, recent: t.recent, options });
          cache[ck] = res;
        } catch (e) {
          failed++;
          const error = String(e.message ?? e).slice(0, 200);
          if (failed <= 5 || failed % 25 === 0) process.stderr.write(`\n  error #${failed}: ${error}\n`);
          cases.push({ ...base, category: 'error', error });
          continue;
        }
      }
      const suggestion = decide(res, options);
      const top = res.rank.ranked.filter(([n]) => n !== NONE).slice(0, 3).map(([n, p]) => `${n} ${p.toFixed(2)}`).join(' · ');
      cases.push({
        ...base,
        category: categorize(t, suggestion),
        suggestion,
        fit: suggestion ? res.verify?.fits?.[suggestion] : null,
        gate: res.rank.gate,
        gates: res.rank.gates,
        top,
        usage: res.usage,
        ms: res.ms,
        stage: res.stage,
      });
      done++;
      if (done % 25 === 0) {
        process.stderr.write(`  ${done} judged, ${failed} failed, ${Math.round((Date.now() - started) / 1000)} s\n`);
        await writeFile(cachePath, JSON.stringify(cache));
      }
    }
  };
  await Promise.all(Array.from({ length: concurrency }, worker));
  process.stderr.write('\n');
  await writeFile(cachePath, JSON.stringify(cache));

  const s = summarize(cases);
  const meta = {
    projectsDir, sessions: sessions.length, model: options.model, date: new Date().toISOString().slice(0, 10),
    gateThreshold: options.gateThreshold, fitsThreshold: options.fitsThreshold, shortlist: DEFAULTS.shortlist, minPromptChars: DEFAULTS.minPromptChars,
  };
  await writeFile(join(outDir, 'cases.json'), JSON.stringify({ meta, summary: s, cases }, null, 1));
  await writeFile(join(outDir, 'report.html'), html(cases, s, roster, meta));
  process.stdout.write(terminal(s, roster) + '\n');
  process.stdout.write(`\n  Report: ${join(outDir, 'report.html')}\n  Cases:  ${join(outDir, 'cases.json')}\n\n`);
}

main().catch(e => { console.error(e); process.exit(1); });
