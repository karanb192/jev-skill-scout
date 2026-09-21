// Renders the audit as one self-contained HTML page and a terminal summary.

const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const pct = (a, b) => (b ? `${((100 * a) / b).toFixed(1)}%` : '0%');

export const CATEGORIES = {
  miss: 'Jev picked a skill; the turn loaded none, and it was not already loaded',
  hit: 'Jev picked the skill the turn loaded',
  'already-loaded': 'Jev picked a skill that an earlier turn had loaded',
  disagree: 'Jev picked one skill; the turn loaded a different one',
  'unsuggested-load': 'The turn loaded a skill; Jev picked none',
  quiet: 'Neither picked a skill',
  trivial: 'Too short to judge; skipped without a call',
  error: 'The request failed',
};

export function summarize(cases) {
  const counts = Object.fromEntries(Object.keys(CATEGORIES).map(k => [k, 0]));
  let calls = 0, input = 0, output = 0, ms = 0, judged = 0;
  const bySkill = {};
  for (const c of cases) {
    counts[c.category] = (counts[c.category] ?? 0) + 1;
    if (c.usage) { calls += c.usage.calls; input += c.usage.input; output += c.usage.output; }
    if (typeof c.ms === 'number') { ms += c.ms; judged++; }
    if (c.category === 'miss') bySkill[c.suggestion] = (bySkill[c.suggestion] ?? 0) + 1;
  }
  const withSkillNeed = counts.miss + counts.hit + counts['already-loaded'] + counts.disagree;
  return {
    total: cases.length,
    counts,
    judged,
    calls,
    tokens: { input, output },
    cost: (input / 1e6) * 0.042,
    avgMs: judged ? Math.round(ms / judged) : 0,
    missRate: pct(counts.miss, withSkillNeed),
    withSkillNeed,
    bySkill: Object.entries(bySkill).sort((a, b) => b[1] - a[1]),
  };
}

export function terminal(s, roster) {
  const lines = [];
  lines.push('');
  lines.push(`jev-skill-scout audit: ${s.total} prompts, ${roster.length} skills in the roster`);
  lines.push('');
  const row = (k, v, note) => lines.push(`  ${String(v).padStart(6)}  ${k.padEnd(18)} ${note}`);
  for (const [k, note] of Object.entries(CATEGORIES)) row(k, s.counts[k] ?? 0, note);
  lines.push('');
  lines.push(`  Turns where Jev saw a skill need: ${s.withSkillNeed}. Missed by the agent: ${s.counts.miss} (${s.missRate}).`);
  if (s.bySkill.length) {
    lines.push('  Most missed skills:');
    for (const [name, n] of s.bySkill.slice(0, 8)) lines.push(`    ${String(n).padStart(4)}  ${name}`);
  }
  lines.push('');
  lines.push(`  ${s.calls} Jev calls, ${s.tokens.input.toLocaleString('en-US')} input tokens, about $${s.cost.toFixed(3)}, ${s.avgMs} ms per judged prompt on average.`);
  return lines.join('\n');
}

export function html(cases, s, roster, meta) {
  const rows = cases
    .filter(c => c.category !== 'trivial' && c.category !== 'quiet')
    .sort((a, b) => (a.category === 'miss' ? -1 : 0) - (b.category === 'miss' ? -1 : 0) || (b.fit ?? 0) - (a.fit ?? 0));
  const tr = c => `<tr data-cat="${c.category}" data-id="${esc(c.id)}">
<td><span class="cat ${esc(c.category)}">${esc(c.category)}</span></td>
<td class="p"><div class="t">${esc(c.text.slice(0, 600))}</div>${c.recent ? `<div class="r">before: ${esc(c.recent.slice(-200))}</div>` : ''}</td>
<td>${c.suggestion ? `<b>${esc(c.suggestion)}</b><br><small>fit ${(c.fit ?? 0).toFixed(2)} · gate ${(c.gate ?? 0).toFixed(2)}</small>` : '<small>none</small>'}${c.top ? `<br><small class="alt">${esc(c.top)}</small>` : ''}</td>
<td>${c.loadedNow.length ? esc(c.loadedNow.join(', ')) : '<small>nothing</small>'}${c.loadedBefore.length ? `<br><small>earlier: ${esc(c.loadedBefore.join(', '))}</small>` : ''}</td>
<td><small>${esc((c.timestamp ?? '').slice(0, 16))}<br>${esc(c.project.replace(/^-/, '').replace(/-/g, '/').slice(-26))}</small></td>
<td class="lab"><label><input type="checkbox" data-v="right"> right</label><label><input type="checkbox" data-v="wrong"> wrong</label></td>
</tr>`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Skill audit: ${s.counts.miss} missed of ${s.withSkillNeed}</title>
<style>
:root{--ink:#1a1917;--muted:#6f6a62;--line:#e4dfd5;--paper:#faf8f3;--card:#fff;--ok:#2a7a3e;--warn:#b0641b;--bad:#a5302a;--accent:#0f5f6b}
body{margin:0;background:var(--paper);color:var(--ink);font:15px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Helvetica,Arial,sans-serif}
main{max-width:1280px;margin:0 auto;padding:32px 24px 80px}
h1{font-size:1.6rem;margin:0 0 6px}
.sub{color:var(--muted);margin:0 0 18px}
.stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px;margin:14px 0 20px}
.stat{background:var(--card);border:1px solid var(--line);border-radius:8px;padding:10px 12px}
.stat b{display:block;font-size:1.5rem}.stat span{color:var(--muted);font-size:12.5px}
.ctl{display:flex;gap:8px;flex-wrap:wrap;margin:10px 0 14px;align-items:center}
button{font:600 12.5px inherit;border:1px solid var(--line);background:var(--card);border-radius:999px;padding:6px 12px;cursor:pointer}
button.on{background:var(--ink);color:var(--paper);border-color:var(--ink)}
table{border-collapse:collapse;width:100%;background:var(--card);border:1px solid var(--line);border-radius:8px;overflow:hidden}
th,td{text-align:left;vertical-align:top;padding:8px 10px;border-bottom:1px solid var(--line)}
th{font-size:11px;letter-spacing:.1em;text-transform:uppercase;color:var(--muted)}
td.p{max-width:440px}.t{white-space:pre-wrap;word-break:break-word}.r{color:var(--muted);font-size:12.5px;margin-top:4px;white-space:pre-wrap}
.cat{font:700 10.5px inherit;letter-spacing:.08em;text-transform:uppercase;padding:3px 7px;border-radius:999px;border:1.5px solid;white-space:nowrap}
.cat.miss{color:var(--bad);border-color:var(--bad)}.cat.hit{color:var(--ok);border-color:var(--ok)}.cat.disagree,.cat.unsuggested-load{color:var(--warn);border-color:var(--warn)}
.cat.already-loaded,.cat.error{color:var(--muted);border-color:var(--line)}
.alt{color:var(--muted)}td.lab label{display:block;white-space:nowrap;font-size:12.5px}
tr.hidden{display:none}tr.right td{background:#eaf3ec}tr.wrong td{background:#f8e9e7}
.skills{display:flex;flex-wrap:wrap;gap:6px;margin:6px 0 16px}.skills span{border:1px solid var(--line);border-radius:999px;padding:2px 9px;font-size:12.5px;background:var(--card)}
pre{background:#1d1c1a;color:#ebe6dc;padding:10px 14px;border-radius:8px;overflow-x:auto;font-size:13px}
</style></head><body><main>
<h1>${s.counts.miss} turns needed a skill that never loaded, out of ${s.withSkillNeed} that needed one</h1>
<p class="sub">${s.total} prompts from ${meta.sessions} sessions under ${esc(meta.projectsDir)} · roster of ${roster.length} skills · judged by ${esc(meta.model)} on ${esc(meta.date)} · ${s.calls} calls, about $${s.cost.toFixed(3)}</p>
<div class="stats">
${Object.entries(CATEGORIES).map(([k, note]) => `<div class="stat"><b>${s.counts[k] ?? 0}</b><span>${esc(k)}: ${esc(note)}</span></div>`).join('\n')}
</div>
<p><b>Most missed skills:</b> ${s.bySkill.length ? s.bySkill.slice(0, 10).map(([n, c]) => `${esc(n)} (${c})`).join(', ') : 'none'}</p>
<p>Read it as a claim to check, not a verdict: every row shows Jev's pick, its fit probability, and what the turn actually loaded. Tick right or wrong on a sample; the counter below turns your ticks into precision. Thresholds: gate ${meta.gateThreshold}, fit ${meta.fitsThreshold}.</p>
<div class="ctl">
<button data-f="all" class="on">all ${rows.length}</button>
${Object.keys(CATEGORIES).filter(k => k !== 'trivial' && k !== 'quiet').map(k => `<button data-f="${k}">${k} ${s.counts[k] ?? 0}</button>`).join('')}
<span id="prec" style="margin-left:auto;color:var(--muted)"></span><button id="copy">Copy labels</button>
</div>
<div style="overflow-x:auto"><table><thead><tr><th>Result</th><th>Prompt</th><th>Jev pick</th><th>Turn loaded</th><th>When, where</th><th>Label</th></tr></thead>
<tbody>${rows.map(tr).join('\n')}</tbody></table></div>
<h2 style="font-size:1.1rem;margin-top:28px">Roster the audit ranked</h2>
<div class="skills">${roster.map(r => `<span title="${esc(r.description.slice(0, 200))}">${esc(r.name)}</span>`).join('')}</div>
<h2 style="font-size:1.1rem">Method</h2>
<p>Each prompt goes through two TypeSafe Jev requests. The first ranks every skill by its description and asks three gate questions (does it act on the user's stuff, does it want a procedure, would prose suffice). Below the gate, nothing is suggested. Above it, the top ${meta.shortlist} skills are re-read with the opening of their instructions, and Jev may reject all of them. A pick counts as a miss only when the turn loaded no skill and the pick was not already loaded earlier in that session. Slash commands you typed count as loads. Subagent transcripts are skipped. Prompts under ${meta.minPromptChars} characters are skipped without a call.</p>
<script>
(function(){
var KEY='jev-skill-scout:'+location.pathname, st={};try{st=JSON.parse(localStorage.getItem(KEY)||'{}')}catch(e){}
var rows=[].slice.call(document.querySelectorAll('tbody tr'));
function save(){try{localStorage.setItem(KEY,JSON.stringify(st))}catch(e){}}
function paint(){var r=0,w=0;rows.forEach(function(tr){var v=st[tr.dataset.id];tr.classList.toggle('right',v==='right');tr.classList.toggle('wrong',v==='wrong');tr.querySelectorAll('input').forEach(function(i){i.checked=i.dataset.v===v});if(tr.dataset.cat==='miss'){if(v==='right')r++;if(v==='wrong')w++}});
document.getElementById('prec').textContent=(r+w)?('miss precision on your labels: '+r+'/'+(r+w)+' = '+Math.round(100*r/(r+w))+'%'):'label some misses to get a precision number'}
rows.forEach(function(tr){tr.querySelectorAll('input').forEach(function(i){i.addEventListener('change',function(){st[tr.dataset.id]=i.checked?i.dataset.v:undefined;save();paint()})})});
document.querySelectorAll('button[data-f]').forEach(function(b){b.addEventListener('click',function(){document.querySelectorAll('button[data-f]').forEach(function(x){x.classList.toggle('on',x===b)});rows.forEach(function(tr){tr.classList.toggle('hidden',b.dataset.f!=='all'&&tr.dataset.cat!==b.dataset.f)})})});
document.getElementById('copy').addEventListener('click',function(){var out=[];rows.forEach(function(tr){if(st[tr.dataset.id])out.push(tr.dataset.id+'\\t'+tr.dataset.cat+'\\t'+st[tr.dataset.id])});navigator.clipboard.writeText(out.join('\\n'))});
paint();
})();
</script></main></body></html>`;
}
