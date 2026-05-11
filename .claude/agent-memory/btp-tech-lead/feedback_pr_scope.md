---
name: Owner prefers tight PRs with explicit out-of-scope flags
description: Bundle co-required work into one PR; defer hardening / nice-to-haves to follow-ups with stated rationale
type: feedback
---

Owner (afl@figaf.com) prefers PRs that ship one cohesive unit of value, with explicit out-of-scope flags for related-but-deferrable work.

**Why:** From the auth-gate brief: "The owner wants a tight, shippable PR." From the brief structure: every section explicitly asks for an out-of-scope flag with reasoning. The owner has shown they want decisions made AND visibility into what was deferred and why.

**How to apply:**
- Bundle co-required changes (anything that makes the PR untestable in isolation, or where a partial ship creates a security/correctness window) into one PR.
- Explicitly flag out-of-scope items in the plan: which audit/review items are being deferred, and the specific reasoning ("blast radius of hypothetical RCE is a different threat model from log-read access").
- Don't volunteer to expand scope just because a related item is "nearby" — propose the deferral, let the owner decide.
- Don't split a PR just because it's >500 LOC. The split criterion is "would each half be safely shippable in isolation?" — if no, keep it one PR.
- For the commit sequence within a single PR: order commits so each leaves the tree in a working state (where possible). Reviewers should be able to step through commit-by-commit.
