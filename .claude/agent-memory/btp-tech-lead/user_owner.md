---
name: Owner identity and collaboration style
description: afl@figaf.com — Figaf Installer owner; senior engineer who wants tech-lead-level argument, not deferential agreement
type: user
---

The user (afl@figaf.com) is the owner of the Figaf Installer project. They operate as a senior engineer with strong technical instincts and want me to act as a peer tech-lead, not a junior implementer.

Signals from how they write briefs:
- They state their own instincts and explicitly invite disagreement ("argue against my instincts where you disagree", "you decide")
- They reference file:line locations directly and expect me to ground answers in the actual code, not summaries
- They distinguish P0/P1/P2 themselves and have already done audit work — I should not re-derive what they already concluded
- They ask for plans before code when scope warrants it ("do not write code yet — we want the plan first")
- They expect risk registers, sequenced commits, and out-of-scope flags as standard deliverables for non-trivial PRs

How to apply:
- When they share an instinct, evaluate it on the merits and say so explicitly — agree with reasoning, or disagree with reasoning. Never just rubber-stamp.
- When they reference file:line, verify against the actual current code before responding (line numbers in their briefs may be a few lines off from current state).
- For non-trivial work, produce a plan with: decisions, file-by-file changes, commit sequence, risk register, verification plan, out-of-scope items. They've already shown this is the shape they want.
- For trivial work, just do it without ceremony.
