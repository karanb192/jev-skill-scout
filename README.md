# jev-skill-scout

Claude Code picks skills on its own, from a list of one-line descriptions that sits in its context next to everything else. Sometimes it does not pick. You find out later: the new screen ignores the design system you wrote a skill for, the endpoint ships with no tests even though your testing skill asks for them, the commit message skips the format you set. Every one of those skills was installed the whole time.

On my own transcripts, 216 sessions over nine weeks, 72% of the turns that needed a skill loaded none. When I checked a sample by hand, about 57% of those held up. Numbers and method below.

This repo does two things about that.

1. **The audit.** `npx jev-skill-scout audit` replays every prompt in your Claude Code transcripts through [TypeSafe's Jev](https://docs.typesafe.ai/introduction) and counts the turns where a skill should have loaded and did not. Each prompt is judged against the skill list its own session showed the model, which the transcript records. One command, one key, one HTML report you can label.
2. **The mod.** A Claude Code [function-hook plugin](https://github.com/anthropics/claude-code/tree/main/mods) that runs the same judgment live, before each prompt reaches the model, and attaches one line: `Relevant to this request: frontend-design.` The model still decides. Your skill list does not change, so prompt caching over it still holds.

Both use the same code in `lib/`. The audit is the mod's brain run offline, so its numbers are what the mod would have done on your history. Once the mod is on, the audit also reads its trace in later transcripts and reports whether the agent followed each suggestion, and the miss rate with the mod against without.

## What the audit found on my transcripts

<!-- audit:start -->
216 sessions, 3,410 human prompts, 3,068 judged (342 were under 12 characters). 58 skills in the roster. 5,785 Jev calls, 24.3M input tokens, $1.02, 48 minutes at 8 requests in parallel from India.

| Fit threshold | Turns where Jev saw a skill need | Loaded nothing | Miss rate |
|---|---|---|---|
| 0.3 (default, the cookbook's) | 1,605 | 1,163 | 72.5% |
| 0.5 | 1,108 | 790 | 71.3% |
| 0.7 | 488 | 344 | 70.5% |

The rate barely moves with the threshold; the count does. Most missed at fit 0.5: my report-writing skill 152, a past-session search skill 85, browser automation 82, an open-source contribution checklist 65, a writing-voice skill 61, a plain-writing style guide 46, Reddit posting 31, blog review 29.

I then read 37 random misses at fit 0.5 and labelled each one myself: 21 right, 16 wrong, so about 57% precision. Take the 790 down to roughly 450 real misses across nine weeks of sessions. Right: "copy this reply, properly formatted and human looking" (the writing-voice skill), "is our post ready to go up?" (Reddit posting), "check my email" (browser automation). Wrong: "current status?" went to the report skill because its description lists the word status, and Jev reads descriptions literally. Two of the wrong ones were questions that needed no procedure at all.

The other direction exists too. At fit 0.5 the agent loaded a skill Jev did not pick 64 times, and only 51 turns were a clean hit. Jev is a second opinion, not an oracle.
<!-- audit:end -->

Jev is the judge here, not ground truth. Every row in the report shows the pick, its fit probability and what the turn actually loaded, so you can tick right or wrong on a sample and the page turns your ticks into a precision number.

## Run the audit

```sh
export TYPESAFE_API_KEY=...        # https://console.typesafe.ai/settings/keys
npx jev-skill-scout audit          # counts prompts, shows the cost, asks before spending
```

What comes back, from my run:

```
jev-skill-scout audit: 3410 prompts, 58 skills in the roster

    1163  miss               Jev picked a skill; the turn loaded none, and it was not already loaded
      54  hit                Jev picked the skill the turn loaded
     327  already-loaded     Jev picked a skill that an earlier turn had loaded
      61  disagree           Jev picked one skill; the turn loaded a different one
      41  unsuggested-load   The turn loaded a skill; Jev picked none
    1422  quiet              Neither picked a skill
     342  trivial            Too short to judge; skipped without a call
       0  error              The request failed

  Turns where Jev saw a skill need: 1605. Missed by the agent: 1163 (72.5%).
  Most missed skills:
     160  (your skills, by name)
     ...

  5785 Jev calls, 24,267,917 input tokens, about $1.019, 7287 ms per judged prompt on average.

  Report: ./skill-audit/report.html
```

Useful flags:

```
--dry-run          count prompts and estimate cost, no requests
--days 30          only sessions touched in the last 30 days
--limit 200        stop after 200 judged prompts
--project name     only projects whose folder contains this text
--out dir          where report.html, cases.json and cache.json go (default ./skill-audit)
--gate 0.3         gate threshold; --fit 0.3 the winner's fit threshold
--yes              skip the confirmation
```

It reads `~/.claude/projects/*/*.jsonl` and every `SKILL.md` under `~/.claude/skills`, `~/.claude/plugins/cache` and `./.claude/skills`. Nothing is written outside the output directory. Judgments are cached, so a second run with new thresholds is free.

Cost: about $0.0003 per judged prompt at the listed Jev price. My 3,068 prompts cost $1.02. Time is the round trip, not the model: about 7 seconds per prompt from India with two calls, so run it with the default 8 in parallel and go make tea.

### What counts as a miss

Every human prompt is one turn. A turn is a **miss** only when all three hold:

- Jev picked a skill after both stages (ranking the whole roster, then re-reading the top three skills' actual instructions and being allowed to reject all of them).
- The turn loaded no skill: no Skill tool call, no `Launching skill` result, no slash command typed.
- That skill was not already loaded earlier in the same session. Skills stay in context once loaded, so suggesting one again would be noise.

The roster for each prompt is the one Claude Code listed to the model in that session (transcripts carry a `skill_listing` record at session start and whenever it changes), so a skill you installed last week is not held against prompts from last month. Sessions with no such record fall back to what is installed now. The verify stage reads today's `SKILL.md` body for skills that still exist.

The other buckets are reported too: **hit** (Jev and the turn agree), **already-loaded**, **disagree** (Jev picked one, the turn loaded another), **unsuggested-load** (the turn loaded a skill Jev did not pick), **quiet** (neither), and **trivial** (prompts under 12 characters, skipped without a call). Subagent transcripts and harness notifications are excluded.

## Install the mod

Function hooks are early access. Nothing loads unless the flag is set, and the API can change between Claude Code releases.

```sh
claude plugin marketplace add karanb192/jev-skill-scout
claude plugin install jev-skill-scout@jev-skill-scout
```

Then in `~/.claude/settings.json`:

```json
{ "env": { "CLAUDE_CODE_ENABLE_FUNCTION_HOOKS": "1", "TYPESAFE_API_KEY": "..." } }
```

Or for one session from a checkout: `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1 claude --plugin-dir /path/to/jev-skill-scout`.

Every option (key, thresholds, timeout, model, quiet, shadow, on/off) is a plugin setting under `/config`, so there is no extra command to learn. With no key the mod loads and does nothing.

**Shadow mode** judges every prompt and shows the pick in the status line but attaches nothing, so you can watch what it would do before letting it. Turn it on under `/config`, or for one session with `JEV_SKILL_SCOUT_SHADOW=1`.

Per prompt it adds one status line and, from India, about 2 to 3 seconds before the model starts (two round trips to a West Coast API). From the US it is well under a second. Set `timeoutMs` lower if that bothers you; on timeout the turn runs untouched.

### What it can reach

Validated on Claude Code 2.1.278:

    ❯ ./register.ts hooks: session.start, prompt.submit
    ❯ ./register.ts calls: $.clock.now, $.clock.sleep, $.env.get, $.fs.exists, $.fs.list, $.fs.read, $.http.fetch, $.session.cwd, $.store.get, $.store.set, $.ui.log, $.ui.status
    ❯ ./register.ts env reads: HOME, JEV_SKILL_SCOUT_SHADOW, TYPESAFE_API_KEY, TYPESAFE_KEY

Reach L3, network. Sees every prompt you type.

- **Reads:** `SKILL.md` files under your home and project skill directories and the enabled plugins' caches, `~/.claude/settings.json` for which plugins are enabled, and four environment variables.
- **Runs:** nothing. No shell.
- **Sends:** your prompt text, the skill names and descriptions, and on the second call the first 700 characters of three skills' instructions, to `api.typesafe.ai`. Nothing else leaves the machine.
- **Persists:** the skill roster in the plugin's own store, refreshed every ten minutes.
- **Hostile input:** a prompt that tries to steer Jev can at most cause a wrong or missing suggestion line, which the model is told to ignore if it does not fit. The mod never loads a skill itself and never blocks a prompt; on any failure it enters the prompt untouched, exactly once.

## How the judgment works

It follows TypeSafe's [skill suggestion cookbook](https://docs.typesafe.ai/cookbooks/skill_suggestion), which measured wrong-skill loads on Haiku dropping from 16.8% to 7.3% with one suggestion line.

1. **Rank.** One request with a Choice over every skill by its description plus a none option, and three Nouls that gate the turn: does it act on the user's files or accounts, would a written procedure help, would prose suffice. Below the gate, nothing is suggested.
2. **Verify.** The top three skills are re-read with the opening of their instructions. A second Choice picks among them or rejects all; a Noul per candidate asks whether loading it would change the work. The winner needs its fit above the threshold.
3. **Attach.** One `<skill_relevance>` block after the prompt, invisible to you, telling the model which skill to load first and to ignore the hint if it does not fit.

Jev returns typed answers with probabilities in one parallel pass, so a 58-skill roster is one request, not 58. A Choice takes at most 255 options; a roster past 250 is ranked in parallel chunks, each chunk keeps its top three, and the verify stage settles it with real excerpts.

## Does the agent obey it?

The line the mod attaches is recorded in the transcript, so the audit can see it. For every turn where the mod spoke, the report shows the suggestion and whether the agent loaded that skill, and it splits the miss rate into sessions where the mod was active and sessions where it was not. Run the mod for a few days, run the audit again, and that paragraph fills in with your own before and after. Nothing else in this space measures that on real sessions; TypeSafe's cookbook number below is from a synthetic set on Haiku.

## Why one line works when the list does not

Claude Code already puts every skill's name and description in context. Three things differ:

- **Menu vs verdict.** The default is a 58-item menu Claude has to match against your prompt on the side, while it plans the answer. The mod hands it a decision: load this one. Following an instruction is a far easier task for a model than noticing a match.
- **Where it sits.** The list lives in the static prefix, tens of thousands of tokens above your prompt. The line is attached to the prompt itself, the last thing Claude reads before it starts.
- **Who decided.** The list is judged on descriptions alone. The pick here was made after re-reading the skills' actual instructions, and Claude is told to drop it if it does not fit.

## Limits

- Claude Code's bundled skills (code-review, deep-research, simplify and the rest) appear in the transcript listing but not on disk, so the audit can judge them and the mod cannot suggest them.
- Skills that were compacted out of context still count as already loaded.
- Jev 1.13 reads literally; a skill with a vague description gets ranked on that vague description. The audit's `disagree` and `unsuggested-load` rows are where to look for descriptions worth rewriting.
- Precision is yours to measure. Label a sample in the report before quoting the miss rate anywhere.
- The obedience numbers only exist once you have run the mod for a while; a fresh audit reports Jev's opinion of your history, not what Claude did with a suggestion.

## Related

- [typesafe-mod](https://github.com/BeLazy167/typesafe-mod) ranks skills on `prompt.submit` too, in one request, with the router off by default and a shell scan for the roster.
- [skillranker](https://github.com/Dicklesworthstone/skillranker) is the most complete live picker: a Rust CLI wired in as a classic `UserPromptSubmit` shell hook, with the same two-stage Jev judgment, local feedback records, a TUI, and Cursor and Pi support. Use it if you want a picker across harnesses. This repo is the same judgment as a mod (no process spawn, footprint printed by the validator) plus the audit, which skillranker does not have.
- [skill-router](https://github.com/lomeshdutta/skill-router) picks skills from the shell at session start.
- [awesome-claude-code-mods](https://github.com/karanb192/awesome-claude-code-mods) scans every mod on GitHub nightly and prints what each one can reach.

## License

MIT.
