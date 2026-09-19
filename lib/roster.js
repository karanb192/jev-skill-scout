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

  const cache = [home, ...PLUGIN_ROOT].join('/');
  for (const market of await dirs(cache)) {
    for (const plugin of await dirs(`${cache}/${market.name}`)) {
      const versions = (await dirs(`${cache}/${market.name}/${plugin.name}`)).map(v => v.name);
      if (!versions.length) continue;
      const v = newestVersion(versions);
      const skillsDir = `${cache}/${market.name}/${plugin.name}/${v}/skills`;
      for (const s of await dirs(skillsDir)) await add(`${skillsDir}/${s.name}`, `${plugin.name}:${s.name}`, `plugin ${market.name}`);
    }
  }
  return [...out.values()];
}

// Skill tool calls name plugin skills as plugin:skill, sometimes as just skill.
export function sameSkill(a, b) {
  if (!a || !b) return false;
  if (a === b) return true;
  return a.split(':').pop() === b.split(':').pop();
}
