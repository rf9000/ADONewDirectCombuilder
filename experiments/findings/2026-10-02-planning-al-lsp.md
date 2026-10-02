# Does the AL language server make planning cheaper?

**Date:** 2026-10-02
**Work item(s):** #83634 (Implement ponto)
**Run IDs:** experiments/runs/83634/20260930-190025 — opus-lsp attempts 1–4. Attempts 1–3 are
kept as `opus-lsp.gated-1`, `opus-lsp.no-warmup-2` and `opus-lsp.rescued-3`.
**Samples per variant:** 1 complete run without rescue (attempt 4), plus 1 rescued run (attempt 3)
**Auth:** subscription; all costs are API-equivalent USD
**Plugin:** claude-code-lsps `al-language-server-go-windows` 1.17.0, wrapping VS Code AL extension
18.0. No `.alpackages`.

## Why we tried it

In the baseline, planner agents made 401 Bash calls (343 of them searches) and 62 Reads.
281 Bash calls touched banking AL code, and Opus read 49.7M cache tokens. One spike showed that
the language server answers the planners' typical questions in a single call: who implements an
interface, an object by name, a file's procedures, callers.

## Variants

Both runs: claude-opus-5-5, high effort, Opus subagents. `opus-lsp` also loads the plugin
(`lsp: true`). Its planning prompt carries an "AL language server" section, and from attempt 4
every agent prompt in the skill carries an LSP block too.

## Key numbers

| Variant | API-equivalent USD | vs baseline | LSP / Bash / Grep / Read | Wall time | Verdict | Scores cov/corr/fit/tasks/qs |
|---|---|---|---|---|---|---|
| opus-high (baseline) | $31.98 | 100% | 0 / 401 / 21 / 62 | 54 min | — | — |
| opus-lsp attempt 3 (rescued) | $37.51 | 117% | 10 / 319 / 0 / 135 | 45 min + rescue | better | 5/4/4/4/3 |
| opus-lsp attempt 4 | $44.44 | 139% | 21 / 394 / 28 / 80 | 60 min | better | 5/5/4/4/4 |

Attempt 4 per model:

- Opus $38.53 (517k output, 56.8M cache-read)
- Sonnet $5.90 (201k output): the orchestrator dispatched some subagents on Sonnet itself

## What happened on the way

1. **Attempt 1 stopped at the Phase 1 gate.** It asked a blocking question about the Ponto
   signing URL, which the baseline had resolved as an ambiguity. That is gate noise, not an LSP
   effect. Gated variants are no longer judged.
2. **Attempt 2 never got past indexing.** The warm-up retried `workspaceSymbol` 12 times. A spike
   showed that `documentSymbol` on a file is what makes the server load the project; it was ready
   about 26 seconds later.
3. **Attempt 3 used LSP 10 times and stopped before writing its plan.** The guidance was in the
   planning prompt only, and the orchestrator did not pass it on to the subagents. Resuming the
   session finished the plan for $6.36. That led to the planning nudge, plus a fix for how resumed
   sessions report cost.
4. **Attempt 4 had the guidance in every agent prompt.** All 21 LSP calls came from the
   orchestrator and the domain planners, early in the run. The verifiers and the test planner
   used none.

## Conclusion

The agents use LSP **in addition to** grep, not instead of it. Exploration volume did not go
down, and cost went up: 117% and 139% of the baseline.

Both complete LSP runs were judged "better" than the baseline, with the highest scores of the
series. Precise lookups might improve plans, but there are two samples and the judge is noisy, so
that is a hypothesis, not a result.

## Decision

- **Do not enable the AL language server for planning to save money.** `AL_LSP_PLUGIN_DIR` stays
  unset in production. The plumbing remains, off by default.
- Do not bake the Linux plugin and the AL extension into the VM image for now.
- If quality becomes the goal rather than cost, a repeat of baseline against `opus-lsp`, two
  samples each, would test the "better" hypothesis. The agent-prompt LSP block does nothing
  without the tool.

## Config change made

None.
