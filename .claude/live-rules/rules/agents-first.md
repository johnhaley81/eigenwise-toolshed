---
description: Agents first on Nexus machines
---
On Nexus machines, work for the agents, not for a human who works by hand. John made this a rule for every project on 2026-10-26 (Nexus Issue #61).

1. If a design choice trades agent reliability, throughput or simplicity for the convenience of a human who works by hand, choose the agent side. Say so in the ticket or the report.
2. Enforce machine hygiene with code, hooks or failing checks, not with prompt text. Machine hygiene is the cleanup of processes and worktrees, and resource limits.
3. A human-facing feature that already ships stays until a decision removes it. Propose its removal as a decision.

This rule is a fork carry for the Nexus machines. It does not go upstream.
