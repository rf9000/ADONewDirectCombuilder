---
name: bank-integration-planner
description: Plans — does not build — a new bank communication integration for Continia Banking. Given API documentation and a reference bank, it validates that enough information exists, runs parallel domain planning agents (authentication, export, import, assisted setup), challenges each plan with a devil's-advocate verifier, revises, then emits an implementation-ready design doc plus a wave-grouped task list for builder agents. Use for "plan a new bank," "design a bank integration," "what's needed to add bank X," or when starting a new bank communication from Swagger/vendor docs.
---

# Bank Integration Planner (Validate → Plan → Refute → Assemble → Decompose)

Produce a **plan**, not code. The deliverable is a `requirement-to-spec`-format design doc plus a `spec-to-tasklist` wave-grouped JSON that builder agents can execute. This skill replaces the old STRICT-COPY `new-bank-communication` command stack: a new bank genuinely differs in auth type, field mapping, and endpoints, so we *plan the differences* instead of copying files.

Pipeline:

```
Phase 0  Gather inputs
Phase 1  validate-information agent ........ GATE: enough to plan? else stop with questions
Phase 2  4 domain planners (parallel) ...... auth | export | import | assisted-setup
Phase 3  plan-verifier per fragment (||) ... devil's advocate tries to REFUTE each plan
Phase 4  domain revision loop (≤2 rounds) .. feed verdicts back; re-verify
Phase 5  test-planner .................... pseudo-test suite (Given/When/Then) from confirmed plans
Phase 6  test-plan-verifier (≤2 rounds) ... devil's advocate tries to REFUTE the suite; revise
Phase 7  assemble design doc ............. requirement-to-spec format; +Setup Data +Test Plan; reserve IDs here
Phase 7b setup-files change list ......... file-by-file changes in the sibling setup-files repo
Phase 8  spec-to-tasklist ............... wave-grouped JSON; one task per object AND one per pseudo-test
Phase 9  Output + handoff to build ....... report artifacts + questions.json; two PRs expected
```

## Output contract (read this first when running headless)

Two repos, two pull requests, one machine-readable questions file.

- **Two repos.** A new bank needs AL objects in **continia-banking** *and* configuration
  JSON in the sibling **setup-files** repo. Both are real deliverables and each gets its own
  pull request. Phase 7b makes the setup-files half explicit; Phase 8 gives it its own wave.
- **`questions.json`.** Whenever a caller supplies an output path for it (an orchestrator
  always does), write your blocking questions and your resolved-ambiguity decisions there in
  addition to the design doc's Open Questions section. Format:

  ```json
  {
    "blocking":     [{ "question": "...", "rationale": "why this blocks planning" }],
    "ambiguities":  [{ "question": "...", "decisionTaken": "...", "rationale": "..." }]
  }
  ```

  Write the file **even when both arrays are empty** — empty is the signal that the plan is
  clear and the build can start. A Phase 1 gate populates `blocking` and stops; residual
  NEEDS-INFO from Phases 4 and 6 populates it too. Never leave a gap silently filled: if you
  chose a default, it belongs in `ambiguities` with the decision stated so a human can
  correct it.

Orchestration uses the `Agent` tool with `subagent_type: "general-purpose"`, dispatched in parallel (same pattern as the `code-review` skill). This repo does not use the `Workflow` tool.

## Non-negotiable rules

1. **Plan only — never write AL.** No codeunits, pages, or enum edits are created by this skill. The output is documents. (Builder agents created later by `spec-to-tasklist` consumers do the writing.)
2. **Don't plan on guesses.** Phase 1 is a hard gate. If a domain lacks the information to be planned soundly, surface it as a blocking question with a suggested default and stop before Phase 2 — do not fabricate endpoints, field names, or auth flows.
3. **Planners cite real knowledge.** Each domain planner reads its mapped knowledge skill (see `references/knowledge-base-map.md`) and an actual reference-bank implementation, and every claim names the pattern/file it rests on. No invented patterns.
4. **Every plan is refuted before it survives.** Phase 3 verifiers actively try to break each fragment (missing interface, wrong auth pattern, unhandled async, endpoint/field mismatch, scope gap, ID/enum-registration error). A fragment reaches the design doc only as CONFIRMED or ADJUSTED, or with its residual gap logged as an Open Question.
5. **Reserve object IDs centrally, once.** Domain and test planners propose objects *without* IDs. The orchestrator reserves real IDs via `mcp__al-object-id-ninja__ninja_assignObjectId` during Phase 7 assembly (production objects against `base-application`, test codeunits against the `*-test` app) — never in parallel inside the planners (avoids collisions). See `.claude/rules/coding-rules/al-object-id-assignment.md`.
6. **Default-first on the four default-backed interfaces; enforce the cleanup invariant.** `IIsAuthenticationValid`, `ICommunicationTypeSpecificUrlValue`, `IGetImportDictionary`, and `ICleanUpBankAccData` each have a `DefaultImplementation` on the `CommunicationType` enum. Plan a per-bank override **only** with a cited reason (see `references/interface-decisions.md`); an unjustified override is a `needless-object` defect, and the wrong default is a `wrong-default-override` defect. **Cleanup invariant:** if onboarding writes any `Bank`/`Bank Account` *table* field, an `ICleanUpBankAccData` implementation must clear exactly those fields (and none a co-resident bank system owns); if it writes none, keep the no-op default and create no cleanup object.

## Phase 0 — Gather inputs

Collect (and confirm) the inputs in **[references/input-checklist.md](references/input-checklist.md)**:

- **New bank name** (PascalCase, no spaces).
- **Reference/inspiration bank** already in the codebase (anchor for patterns).
- **Swagger/OpenAPI path or URL** + any vendor docs.
- **Operations in scope**: payments, direct debit, account statements, payment status.
- **Auth type** if known (OAuth+refresh / SFTP-agreement / certificate / external-wrapper).
- **Output path** for the design doc + task list (user-supplied; default to a scratch path beside the inputs).

## Phase 1 — validate-information (GATE)

Dispatch one agent from `agents/validate-information.md` with the Phase 0 inputs. It returns per-domain readiness (auth / export / import / assisted-setup) plus a list of blocking gaps, each framed as a question with a suggested default.

- **Any blocking gap** → present the gaps to the user, **write them to `questions.json`** (see Output contract), and **stop**. Do not proceed to Phase 2 on assumptions.
- **All domains ready** (or only non-blocking gaps, which become Open Questions later) → proceed.

## Phase 2 — Domain planners (parallel, one message)

Read the four prompt files and dispatch all four in a single message (`Agent`, `general-purpose`). They run independently — never feed one planner another's output. Each receives: its prompt file, the Phase 0 inputs, and its knowledge-base map entry.

| Domain | Prompt file | Cites (knowledge base) |
|--------|-------------|------------------------|
| Authentication | `agents/auth-planner.md` | `new-bank-communication` + `async-flow-patterns`, `request-header-mapping`, `swagger-api-reader` |
| Export | `agents/export-planner.md` | `bank-communication-operations` (export-patterns) + `async-flow-patterns` |
| Import | `agents/import-planner.md` | `bank-communication-operations` (import-patterns) + `async-flow-patterns` |
| Assisted Setup | `agents/assisted-setup-planner.md` | `bank-system-setup-wizard` + `assisted-setup-wizard` |

Each returns a **plan fragment** in the format defined in `agents/auth-planner.md > Output` (objects + interface-decisions + field mappings + `ONBOARDING_FIELDS_WRITTEN` + endpoints/URL keys + enum-registration contribution + decisions + open questions + evidence), with objects listed **without IDs**. The default-vs-override calls for the four default-backed interfaces follow **`references/interface-decisions.md`** (auth owns `IIsAuthenticationValid` + `ICommunicationTypeSpecificUrlValue`; import owns `IGetImportDictionary`; `ICleanUpBankAccData` is consolidated at assembly from every fragment's `ONBOARDING_FIELDS_WRITTEN`).

## Phase 3 — Verification (parallel, one verifier per fragment)

Dispatch one `agents/plan-verifier.md` agent per fragment, all in one message. Each is told its domain and is given that fragment plus the Phase 0 inputs and the Swagger. It tries to **refute** the plan across the failure categories in its prompt (missing/wrong interface, wrong auth pattern, unhandled async, endpoint mismatch, unmapped required field, scope gap, enum-registration/ID error). Verdict per challenge: CONFIRMED / ADJUSTED / REFUTED / NEEDS-INFO, plus an OVERALL of CONFIRMED or NEEDS-REVISION.

## Phase 4 — Domain revision loop (≤2 rounds)

For each fragment with OVERALL = NEEDS-REVISION, re-dispatch that domain's planner with its prior fragment + the verifier's REQUIRED_REVISIONS, then re-verify (one verifier). **Cap at 2 revision rounds.** Anything still NEEDS-INFO after round 2 is not blocked forever — it is carried into the design doc's **Open Questions** with a suggested default. Fragments that are CONFIRMED skip the loop.

## Phase 5 — Test planner

Dispatch one `agents/test-planner.md` agent with **all confirmed domain fragments** + the consolidated Setup Data + the Open Questions. It writes the **whole test suite up front as human-reviewable pseudo-tests** in `scenario / given / when / then` shape, grouped into the four test codeunits seen in `base-application-test/Communication/JPMorgan/` (`Test<Bank>Auth/Export/Import/Feature`). It enforces CLAUDE.md's red-first + negative-tests-required discipline (every behavior gets a negative/boundary case), keeps every assertion observable, and proposes the test codeunits **without IDs**.

This phase runs **after** the domain plans are confirmed — the suite is derived from decided behavior, not guessed. The pseudo-tests are the artifact a human reviews before any code is written, and the source `spec-to-tasklist` turns into one task per test.

## Phase 6 — Test-plan verification + revision (≤2 rounds)

Dispatch one `agents/test-plan-verifier.md` agent (devil's advocate, test-specific challenge set: coverage gap, missing negative/boundary, untestable assertion, wrong fake strategy, red-first violation, mis-mapped `covers`). If OVERALL = NEEDS-REVISION, re-dispatch the test planner with the REQUIRED_REVISIONS, then re-verify. **Cap at 2 rounds**; residual NEEDS-INFO becomes an Open Question. The confirmed suite feeds the design doc's Test Plan section.

## Phase 7 — Assemble the design doc

Merge the confirmed/adjusted fragments into a single design document in **`requirement-to-spec` output-contract format** (read `.claude/skills/requirement-to-spec/references/output-contract.md`). Specifically:

1. **Metadata** — bank name, type (AppSource — base-application), target module (`base-application/Bank Communication`), BC version, ID range, date, author.
2. **Resolve cleanup (the `ICleanUpBankAccData` invariant).** Union every fragment's `ONBOARDING_FIELDS_WRITTEN`. If the union is **non-empty**, add a `CTS-CB <Bank>ClnUpBnkAccData` codeunit (interface `ICleanUpBankAccData`) that clears exactly those `Bank`/`Bank Account` table fields — and confirm none belongs to a co-resident bank system (see `references/interface-decisions.md §4`); register it in the enum. If the union is **empty**, keep the no-op default and add **no** cleanup object. (This is the rule-6 invariant; the per-fragment verifier already checked each fragment, but the union check only exists here.)
3. **Object Inventory** — union of all fragments' objects (incl. any per-bank override codeunits that survived the default-first check, and the cleanup object from step 2) **plus the test codeunits** from the confirmed Test Plan. **Now reserve a real ID per object** via the ninja MCP (sequentially, in the orchestrator) — production objects against `base-application`, **test codeunits against the relevant `*-test` app's own range**. Include the `CommunicationType` enum-registration edit as its own row.
4. **Field Mapping** — per-object request/response field tables from the fragments.
5. **External Integration** — endpoints, URL keys, async polling pattern.
6. **Setup Data** — union of every fragment's `SETUP_DATA_REQUIRED` (allowed file types per direction, default formats, payment methods, bank-system code) as the **setup-JSON entries the new bank needs**. This is config data authored in the sibling setup-files repo, **not** AL objects (see `references/setup-data-model.md`). Phase 7b turns this section into the concrete file-by-file change list.
7. **Test Plan** — the confirmed pseudo-test suite from Phase 6, grouped by test codeunit, each test in its `scenario / given / when / then / type / covers` shape. This is the **human-reviewable** section: a reviewer validates the suite here before any code is written. `spec-to-tasklist` reads this section to emit one task per pseudo-test (field names `covers` / `then` / `type` must match exactly).
8. **Decisions & Limitations** — consolidate every fragment's `INTERFACE_DECISIONS` (default-vs-override calls with reasons) and `Decision note` / `Why` / `Known limitation` (keep markers inline in the relevant sections too).
9. **Open Questions / Resolved** — residual NEEDS-INFO items (each with a default), or a Resolved table for anything settled with the user.

Write the design doc to the Phase 0 output path.

## Phase 7b — Setup-files change list (the second repo)

The Setup Data section from step 6 says *what* config the bank needs. This phase says *which
files change and how* — because the setup-files work is a separate repo, a separate pull
request, and the half most often forgotten.

Resolve the repo path from `.claude/repo-paths.json` → `setup-files` (see
`setup-files-investigate` Step 0). **Read the reference bank's real entries first** and mirror
their shape; never invent a schema. Produce a **Setup-Files Changes** section in the design
doc, one row per file, each naming the JSON top-level keys (= AL table names) being added:

| What | File | Top-level keys to add |
|------|------|------------------------|
| Bank system definition + payment methods + field validations | `Files/Bank System/{BankSystemCode}.json` | `CTS-CB Bank System` (incl. `Communication Type`), `Payment Method`, `CTS-CB Bank System Pmt. Mth.`, `CTS-CB Field Validation`, `CTS-CB Validation Set` |
| Bank entry + communication type setup | `Files/Bank/{BankCode}.json` | `CTS-CB Bank` (incl. `Default Import/Export`), `CTS-CB Bank System Mapping2` (incl. `Supported Communication` = the new `CommunicationType` enum value, and `Import/Export Comm Type`) |
| Allowed file types the bank system accepts for export | `Files/Bank System - Export/{BankSystemCode}.json` | per the reference bank's file |
| Allowed file types the bank system accepts for import | `Files/Bank System - Import/{BankSystemCode}.json` | per the reference bank's file |
| **Request header mappings** | **look it up — see below** | `CTS-CB Request Header Mapping` |

**Request header mapping — do not guess the path.** The `CTS-CB Request Header Mapping` table
is filtered by `Bank System Code` at runtime (see
`bank-communication-operations/references/export-patterns.md` →
`SetRequestHeaderMappingFilter`), but its file category is **not** documented in
`setup-files-investigate/docs/repo-structure.md`. So: grep the setup-files repo for
`CTS-CB Request Header Mapping`, find the reference bank's entries, and **cite the actual file
you found** in the change list. Mirror its structure for the new bank system, covering every
header the auth/export/import fragments said the API requires.

Also confirm, from `GeneralData.json`'s `CTS-CB File Architecture`, that each table you are
adding to is actually imported for that file category — and note its `Data Update` strategy if
a reviewer would need to know whether existing records get replaced.

**Boundary check.** Nothing in this phase may be an AL object or a `Bank`/`Bank Account` table
field, and nothing planned as an AL object in step 3 may reappear here. The
Bank/Bank-Account fields the assisted setup writes (Application User ID, Account ID, Agreement
No, signup URLs) stay AL table fields — column 3 of `references/setup-data-model.md`.

## Phase 8 — Emit the task list

Invoke the **`spec-to-tasklist`** skill on the assembled design doc. It produces the wave-grouped JSON: one task per AL object **and one task per pseudo-test** (the Test Plan section). The enum-registration task lands in the final wave (depends on every per-interface codeunit); per-test tasks depend on the production objects they `cover` plus their test-codeunit scaffold, and same-codeunit test tasks are serialized on a shared file touch point. Write the JSON beside the design doc.

**Setup-files tasks get their own wave.** Emit one task per file from the Phase 7b change list,
each tagged with `repo: "setup-files"` (AL tasks are `repo: "continia-banking"`). They have no
dependency on the AL waves — different repo, different pull request — so they can run in
wave 1 alongside the AL scaffolding. The one ordering constraint worth stating: the
`CTS-CB Bank System Mapping2` entry's `Supported Communication` value must match the
`CommunicationType` enum value the AL side registers, so put that value in the task's inputs
rather than leaving the builder to infer it.

## Phase 9 — Output + handoff to build

Report all artifacts (design doc path + task list path + `questions.json` path) and a one-line summary: bank name, object count, **test count**, **setup-files file count**, wave count, and any Open Questions the user still needs to resolve before the build.

State plainly whether the plan is **complete** (both `questions.json` arrays empty) or **waiting on answers**. An orchestrator branches on exactly that.

**Handoff to build (the planner does not run it — rule 1, plan-only).** The build phase that consumes the task list opens by provisioning a test environment via the `continia-env-setup` skill, then `continia-deps` → `continia-deploy` → `continia-test`, and ends with **two pull requests** — one on continia-banking for the AL work, one on setup-files for the config. End the summary with: `Next: provision env (continia-env-setup), then build wave 1. Expect 2 PRs.`

## References

- Required inputs: `references/input-checklist.md`
- Sibling repo paths (resolve `continia-banking` and `setup-files`): `.claude/repo-paths.json`
- Knowledge-base map (which skill each planner cites): `references/knowledge-base-map.md`
- Interface decisions (default vs override for the four default-backed interfaces): `references/interface-decisions.md`
- **Setup-data model (what setup-JSON config controls vs what this planner plans): `references/setup-data-model.md`**
- Setup-file investigation (allowed file types, payment methods, capabilities): `.claude/skills/setup-files-investigate/`
- Test planning + verification agents: `agents/test-planner.md`, `agents/test-plan-verifier.md`
- Design-doc format: `.claude/skills/requirement-to-spec/references/output-contract.md`
- Task-list schema: `.claude/skills/spec-to-tasklist/references/schema.md`
- Build/test environment (build-phase handoff): `.claude/skills/continia-env-setup/`, `continia-deps`, `continia-deploy`, `continia-test`
- Object IDs: `.claude/rules/coding-rules/al-object-id-assignment.md`
- LSP usage: `.claude/rules/USE-AL-LSP-TOOLS/`
