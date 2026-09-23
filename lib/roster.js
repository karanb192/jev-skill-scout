// Finds every SKILL.md Claude Code can load and reads its frontmatter.
// Pure over an injected fs so the mod (engine $.fs) and the CLI (node:fs) share it.

const PLUGIN_ROOT = ['.claude', 'plugins', 'cache'];

export function parseFrontmatter(text) {
  const lines = text.split('\n');
  let i = 0;
  while (i < lines.length && lines[i].trim() === '') i++;
  if ((lines[i] ?? '').trim() !== '---') return { fields: {}, body: text };
  i++;
  const fields = {};
  let key = '';
  let buf = [];
  const flush = () => {
    if (key) fields[key] = buf.join(' ').replace(/\s+/g, ' ').trim();
    key = '';
    buf = [];
  };
  for (; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === '---') { i++; break; }
    const m = /^([A-Za-z_][\w-]*):[ \t]*(.*)$/.exec(line);
    if (m && !/^[ \t]/.test(line)) {
      flush();
      key = m[1];
      const value = m[2].trim();
      if (value && !/^[>|][-+]?$/.test(value)) buf.push(value.replace(/^["']|["']$/g, ''));
    } else if (key && line.trim()) {
      buf.push(line.trim());
    }
  }
  flush();
  return { fields, body: lines.slice(i).join('\n') };
}

// Version directories sort as 1.10.0 > 1.9.0, not as strings.
function versionKey(v) {
  return v.split(/[.-]/).map(p => (/^\d+$/.test(p) ? Number(p) : -1));
}
function newestVersion(names) {
  return [...names].sort((a, b) => {
    const ka = versionKey(a), kb = versionKey(b);
    for (let i = 0; i < Math.max(ka.length, kb.length); i++) {
      const d = (kb[i] ?? -1) - (ka[i] ?? -1);
      if (d) return d;
    }
    return 0;
  })[0];
}

/**
 * @param {{ list(p:string):Promise<{name:string,kind:string}[]>, read(p:string):Promise<string>, exists(p:string):Promise<boolean> }} fs
 * @param {{ home:string, cwd?:string, bodyChars?:number }} where
 * @returns {Promise<{ name:string, description:string, excerpt:string, path:string, source:string }[]>}
 */
export async function readRoster(fs, { home, cwd, bodyChars = 700 }) {
  const out = new Map();
  const add = async (skillDir, name, source) => {
    const p = `${skillDir}/SKILL.md`;
    if (!(await fs.exists(p))) return;
    let text;
    try { text = await fs.read(p); } catch { return; }
    const { fields, body } = parseFrontmatter(text.slice(0, 12000));
    const description = fields.description ?? '';
    if (!description) return;
    const key = name;
    if (out.has(key)) return;
    out.set(key, {
      name: key,
      description,
      excerpt: body.replace(/\s+/g, ' ').trim().slice(0, bodyChars),
      path: p,
      source,
    });
  };
  const dirs = async p => {
    try { return (await fs.list(p)).filter(e => !e.name.startsWith('.')); } catch { return []; }
  };

  if (cwd) for (const e of await dirs(`${cwd}/.claude/skills`)) await add(`${cwd}/.claude/skills/${e.name}`, e.name, 'project');
  for (const e of await dirs(`${home}/.claude/skills`)) await add(`${home}/.claude/skills/${e.name}`, e.name, 'user');

  // Only enabled plugins reach the model's skill list; a cached but disabled
  // one must not be suggested. Without readable settings, every plugin counts.
  let enabled = null;
  try {
    const settings = JSON.parse(await fs.read(`${home}/.claude/settings.json`));
    if (settings && typeof settings.enabledPlugins === 'object') enabled = settings.enabledPlugins;
  } catch { enabled = null; }

  const cache = [home, ...PLUGIN_ROOT].join('/');
  for (const market of await dirs(cache)) {
    for (const plugin of await dirs(`${cache}/${market.name}`)) {
      if (enabled && enabled[`${plugin.name}@${market.name}`] !== true) continue;
      const versions = (await dirs(`${cache}/${market.name}/${plugin.name}`)).map(v => v.name);
      if (!versions.length) continue;
      const v = newestVersion(versions);
      const skillsDir = `${cache}/${market.name}/${plugin.name}/${v}/skills`;
      for (const s of await dirs(skillsDir)) await add(`${skillsDir}/${s.name}`, `${plugin.name}:${s.name}`, `plugin ${market.name}`);
    }
  }
  return [...out.values()];
}

/**
 * The roster as Claude Code itself listed it in a transcript (`skill_listing`
 * attachments): one `- name: description` per skill, long descriptions wrapped.
 */
export function parseListing(content) {
  const out = [];
  for (const raw of String(content ?? '').split('\n')) {
    const m = /^- ([^\s:]+(?::[^\s:]+)?): ?(.*)$/.exec(raw);
    if (m) out.push({ name: m[1], description: m[2].trim() });
    else if (out.length && raw.trim()) out[out.length - 1].description += ` ${raw.trim()}`;
  }
  return out;
}

/**
 * Codex's skills: ~/.codex/skills (and its .system dir), ~/.agents/skills, and
 * plugin caches. Names are plain; Codex lists them without a plugin prefix.
 */
export async function readCodexRoster(fs, { home, bodyChars = 700 }) {
  const out = new Map();
  const dirs = async p => {
    try { return await fs.list(p); } catch { return []; }
  };
  const add = async (skillDir, name, source) => {
    const p = `${skillDir}/SKILL.md`;
    if (out.has(name) || !(await fs.exists(p))) return;
    let text;
    try { text = await fs.read(p); } catch { return; }
    const { fields, body } = parseFrontmatter(text.slice(0, 12000));
    if (!fields.description) return;
    out.set(name, { name, description: fields.description, excerpt: body.replace(/\s+/g, ' ').trim().slice(0, bodyChars), path: p, source });
  };
  const roots = [[`${home}/.codex/skills`, 'user'], [`${home}/.codex/skills/.system`, 'system'], [`${home}/.agents/skills`, 'agents']];
  for (const [root, source] of roots) for (const e of await dirs(root)) if (!e.name.startsWith('.')) await add(`${root}/${e.name}`, e.name, source);
  const cache = `${home}/.codex/plugins/cache`;
  for (const plugin of await dirs(cache)) {
    for (const e of await dirs(`${cache}/${plugin.name}`)) if (!e.name.startsWith('.')) await add(`${cache}/${plugin.name}/${e.name}`, e.name, `plugin ${plugin.name}`);
    for (const e of await dirs(`${cache}/${plugin.name}/skills`)) await add(`${cache}/${plugin.name}/skills/${e.name}`, e.name, `plugin ${plugin.name}`);
  }
  return [...out.values()];
}

// Skill tool calls name plugin skills as plugin:skill, sometimes as just skill.
export function sameSkill(a, b) {
  if (!a || !b) return false;
  if (a === b) return true;
  return a.split(':').pop() === b.split(':').pop();
}
