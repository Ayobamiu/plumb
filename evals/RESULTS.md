# Plumb eval results

All scenarios use made-up people, emails and sessions. Prompts were tuned on the dev set only. The held-out sets have never been run; they run once, on Nov 3, and their numbers go in the last section unchanged.

## 1. Keeping claims true (the brain)

Each scenario writes claims from texts (session notes, doc edits), then sends events (emails, doc edits, clock ticks) and checks every claim's status after each one. 24 dev scenarios, 14 held out.

Dev set, Oct 28, `pnpm eval:model --split dev --runs 2` (model systems pooled over 2 runs):

| System | Detection recall | Chain recall | False retraction | REVIEW precision | Time to flag |
| --- | --- | --- | --- | --- | --- |
| Do nothing (claims stay IN forever) | 0% (0/28) | 0% (0/11) | 0% (0/84) | n/a | n/a |
| Plumb, code only (no model) | 61% (11/18) | 90% (9/10) | 0% (0/52) | n/a | instant |
| LLM only (Muse Spark sees all claims and events, says which are false) | 85% (22/26) | 71% (10/14) | 5.9% (4/68) | n/a | 2.6 s |
| **Plumb (code plus Muse Spark checks)** | **96% (54/56)** | **100% (22/22)** | **0% (0/166)** | **100% (20/20)** | 1.3 s |

- Detection recall: of the claims that became false, how many were flagged (OUT or REVIEW).
- Chain recall: of the claims that should fall because a claim they rest on fell, how many did.
- False retraction: how often a still-true claim was marked OUT. This is the number that kills trust. Plumb's code never marks a claim OUT on a model's word; a model can only send it to REVIEW.
- Plumb passed 23 of 24 scenarios exactly in both runs. The miss both times was s21, a borderline background re-check.
- LLM only can't run 11 of the 24 scenarios (texts that create claims, restores, sweeps, links), so its numbers cover 13. It can't say REVIEW, so "exact" isn't comparable; compare the metrics.
- Extraction (texts to claims) found 100% (38/38) of the claims the texts state, with 0.7 extra claims per text. Link suggestions: 2 of 2 right, 0 wrong.
- Cost: about $0.23 per full dev run of Plumb with the model, $0.10 for LLM only.

## 2. Finding a session from a description (search)

`/plumb gym plan from Claude last week`: 27 made-up sessions across Claude Code, Cursor, Claude chat, docs, email and notes; 45 natural-language queries (35 dev, 10 held out), including 7 where the right answer is "not found".

Dev set, Oct 28, `pnpm eval:search:model`:

| System | Right session first | Right one in top 4 | Says "not found" when right |
| --- | --- | --- | --- |
| Keyword match (every word must match; what find_context did before) | 23% (7/30) | 23% | 100% (5/5) |
| Any shared word, code only | 83% (25/30) | 93% | 20% (1/5) |
| **Muse Spark ranks the candidates (prompt search.v3)** | **100% (30/30)** | **100%** | **100% (5/5)** |

- search.v2 scored the same over 2 runs (60/60, 10/10). search.v1 scored 97%: its two misses said "not found" with the right session listed as an alternative.
- Cost: about $0.004 per search; median 1.6 s on this set, 2 to 10 s on live data.

## 3. Held-out (final run, Nov 3)

Not run yet. Commands:

```
pnpm eval:model --split heldout --runs 3
pnpm eval:search:model --split heldout --runs 3
```
