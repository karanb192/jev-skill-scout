# jev-skill-scout

Claude Code picks skills on its own, from a list of one-line descriptions that sits in its context next to everything else. Sometimes it does not pick. You find out later: the new screen ignores the design system you wrote a skill for, the endpoint ships with no tests even though your testing skill asks for them, the commit message skips the format you set. Every one of those skills was installed the whole time.

This repo does two things about that.

1. **The audit.** `npx jev-skill-scout audit` replays every prompt in your Claude Code transcripts through [TypeSafe's Jev](https://docs.typesafe.ai/introduction) and counts the turns where a skill should have loaded and did not. One command, one key, one HTML report you can label.
2. **The mod.** A Claude Code [function-hook plugin](https://github.com/anthropics/claude-code/tree/main/mods) that runs the same judgment live, before each prompt reaches the model, and attaches one line: `Relevant to this request: frontend-design.` The model still decides. Your skill list does not change, so prompt caching over it still holds.

Both use the same code in `lib/`. The audit is the mod's brain run offline, so its numbers are what the mod would have done on your history.

## What the audit found on my transcripts

<!-- audit:start -->
216 sessions, 3,410 human prompts, 3,068 judged (342 were under 12 characters). 58 skills in the roster. 5,785 Jev calls, 24.3M input tokens, $1.02, 48 minutes at 8 requests in parallel from India.

| Fit threshold | Turns where Jev saw a skill need | Loaded nothing | Miss rate |
|---|---|---|---|
| 0.3 (default, the cookbook's) | 1,605 | 1,163 | 72.5% |
| 0.5 | 1,108 | 790 | 71.3% |
| 0.7 | 488 | 344 | 70.5% |

The rate barely moves with the threshold; the count does. Most missed at fit 0.5: karan-report 152, search-conversations 85, cdp-browser-automation 82, oss-contribute 65, humanizer 61, plain-writing 46, reddit-posting 31, blog-review 29.

I then read 37 random misses at fit 0.5 and labelled each one myself (`docs/author-labels-2026-09-19.json`): 21 right, 16 wrong, so about 57% precision. Take the 790 down to roughly 450 real misses across nine weeks of sessions. Right: "copy reply to [name], properly formatted and human looking" (humanizer), "time to post on r/macapps, is our post super ready?" (reddit-posting), "check my email" (cdp-browser-automation). Wrong: "current status?" went to karan-report because that skill's description lists the word status, and Jev reads descriptions literally. Two of the wrong ones were questions that needed no procedure at all.

The other direction exists too. At fit 0.5 the agent loaded a skill Jev did not pick 64 times, and only 51 turns were a clean hit. Jev is a second opinion, not an oracle.
<!-- audit:end -->

Jev is the judge here, not ground truth. Every row in the report shows the pick, its fit probability and what the turn actually loaded, so you can tick right or wrong on a sample and the page turns your ticks into a precision number.

## Run the audit

```sh
export TYPESAFE_API_KEY=...        # https://console.typesafe.ai/settings/keys
npx jev-skill-scout audit          # counts prompts, shows the cost, asks before spending
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

Every option (key, thresholds, timeout, model, quiet, on/off) is a plugin setting under `/config`, so there is no extra command to learn. With no key the mod loads and does nothing.

Per prompt it adds one status line and, from India, about 2 to 3 seconds before the model starts (two round trips to a West Coast API). From the US it is well under a second. Set `timeoutMs` lower if that bothers you; on timeout the turn runs untouched.

### What it can reach

Validated on Claude Code 2.1.278:

    ❯ ./register.ts hooks: session.start, prompt.submit
    ❯ ./register.ts calls: $.clock.now, $.clock.sleep, $.env.get, $.fs.exists, $.fs.list, $.fs.read, $.http.fetch, $.session.cwd, $.store.get, $.store.set, $.ui.log, $.ui.status
    ❯ ./register.ts env reads: HOME, TYPESAFE_API_KEY, TYPESAFE_KEY

Reach L3, network. Sees every prompt you type.

- **Reads:** `SKILL.md` files under your home and project skill directories, and three environment variables.
- **Runs:** nothing. No shell.
- **Sends:** your prompt text, the skill names and descriptions, and on the second call the first 700 characters of three skills' instructions, to `api.typesafe.ai`. Nothing else leaves the machine.
- **Persists:** the skill roster in the plugin's own store, refreshed every ten minutes.
- **Hostile input:** a prompt that tries to steer Jev can at most cause a wrong or missing suggestion line, which the model is told to ignore if it does not fit. The mod never loads a skill itself and never blocks a prompt; on any failure it enters the prompt untouched, exactly once.

## How the judgment works

It follows TypeSafe's [skill suggestion cookbook](https://docs.typesafe.ai/cookbooks/skill_suggestion), which measured wrong-skill loads on Haiku dropping from 16.8% to 7.3% with one suggestion line.

1. **Rank.** One request with a Choice over every skill by its description plus a none option, and three Nouls that gate the turn: does it act on the user's files or accounts, would a written procedure help, would prose suffice. Below the gate, nothing is suggested.
2. **Verify.** The top three skills are re-read with the opening of their instructions. A second Choice picks among them or rejects all; a Noul per candidate asks whether loading it would change the work. The winner needs its fit above the threshold.
3. **Attach.** One `<skill_relevance>` block after the prompt, invisible to you, telling the model which skill to load first and to ignore the hint if it does not fit.

Jev returns typed answers with probabilities in one parallel pass, so a 58-skill roster is one request, not 58.

## Limits

- The roster is what is installed now. A skill you installed last week is judged against prompts from last month.
- Skills that were compacted out of context still count as already loaded.
- Jev 1.13 reads literally; a skill with a vague description gets ranked on that vague description. The audit's `disagree` and `unsuggested-load` rows are where to look for descriptions worth rewriting.
- Precision is yours to measure. Label a sample in the report before quoting the miss rate anywhere.

## Related

- [typesafe-mod](https://github.com/BeLazy167/typesafe-mod) ranks skills on `prompt.submit` too, in one request, with the router off by default and a shell scan for the roster.
- [skill-router](https://github.com/lomeshdutta/skill-router) and [skillranker](https://github.com/Dicklesworthstone/skillranker) pick skills from the shell at session start.
- [awesome-claude-code-mods](https://github.com/karanb192/awesome-claude-code-mods) scans every mod on GitHub nightly and prints what each one can reach.

## License

MIT.
