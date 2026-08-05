# Where a bank's behavior actually lives (read before planning)

A new bank is **not** only AL objects. A large part of a bank's behavior — which file
types it accepts, its default formats, its payment methods, its field validations — is
**configuration data in the setup-JSON repo**, imported into BC tables at runtime. Planning
mistakes happen when a planner proposes an AL object (or assumes a hard-coded value) for
something that is really setup-file config.

Consult this model for every value you are about to plan. If a value lives in column 1 or 2,
**do not** plan an AL object or a `Bank`/`Bank Account` table field for it.

## The three places behavior lives

| # | Lives in | Owned/described by | Examples |
|---|----------|--------------------|----------|
| 1 | **Setup JSON files** (sibling setup-files repo; imported to BC tables) | `setup-files-investigate` skill | Bank system definition, **allowed file types per direction**, **default import/export formats**, payment methods, field validations, ISO transaction codes, bank closing days |
| 2 | **Runtime `BankAccComSetup` table** (per bank account, set by the wizard) | `bank-system-setup-wizard` skill (the 6 ownership rules) | Which payment method a given bank account uses; payment-method **ownership/conflict resolution** across co-resident bank systems |
| 3 | **AL objects + `Bank`/`Bank Account` table fields** | this planner (auth/export/import/setup planners) | Auth/Export/Import codeunits, interface implementations, the `CommunicationType` enum value, onboarding table fields (Application User ID, Account ID, Agreement No, signup URLs) |

## Setup-JSON file categories (column 1 — cite exact paths)

From `setup-files-investigate` (resolve the repo path via `.claude/repo-paths.json` → `setup-files`):

| What you're planning | File category | Path |
|----------------------|---------------|------|
| Default import + export **format** for the bank | Bank | `Files/Bank/{BankCode}.json` |
| **Allowed file types** (both directions) | Bank System | `Files/Bank System/{BankSystemCode}.json` → `CTS-CB Bank System Com. Setup` |
| Per-direction placeholder files — **not** where file types live | Bank System - Export / Import | `Files/Bank System - {Export,Import}/{BankSystemCode}.json` |
| Payment methods, field validations, validation sets | Bank System | `Files/Bank System/{BankSystemCode}.json` |
| ISO bank transaction codes | Import Setup | `Files/ImportSetup.json` |
| Bank closing days (holidays) | Export Setup | `Files/ExportSetup.json` |

## The rule

> **Do NOT plan an AL object — or a `Bank`/`Bank Account` table field, or a hard-coded
> constant — for something that is setup-file config or a runtime `BankAccComSetup` choice.**

**Worked example (the mistake this doc exists to prevent):** "the bank accepts PAIN.001 for
export and CAMT.053 for import." Those **allowed file-type values are setup-JSON config**
(`Files/Bank System/{code}.json`, under `CTS-CB Bank System Com. Setup`), looked up at
runtime — not an enum, not a codeunit branch, not a `Bank` table field. The export/import
codeunits *read* the configured file type; they don't *define* it. Planning a per-bank object
to "select the file type" is a `needless-object` defect.

**The per-direction folders are placeholders, despite their names.** An earlier version of this
doc sent planners to `Files/Bank System - Export|Import/{code}.json` for file types; they are not
there. Verified 2026-08-05: `Files/Bank System - Export/ABNAMROISO20022.json` is literally `{}`
(2 bytes) and its Import counterpart is 119 bytes of empty description-template arrays, while ABN
AMRO's real file types sit in `Files/Bank System/ABNAMROISO20022.json`. All three folders carry
the same 90 filenames and every export placeholder is ≤ 4 bytes — so **still create the
placeholders for folder parity**, just don't put file types in them.

## A new bank needs new setup-JSON entries too

Because column 1 is real deliverable data, the design doc must **list the setup-JSON entries
the new bank requires** (bank-system code, allowed file types per direction, default formats,
payment methods) — not just AL objects. Each planner reports these in its fragment's
`SETUP_DATA_REQUIRED` block; assembly consolidates them into the design doc's **Setup Data**
section. Authoring those JSON files lives in the sibling setup-files repo and is downstream of
this plan — but the plan must name them so nothing is silently missed.

### `"Communication Type"` is an enum value name — state it explicitly

When `SETUP_DATA_REQUIRED` names the `CTS-CB Bank System` header row, the
`"Communication Type"` value must be the **`CommunicationType.Enum.al` value name**, not the
bank code and not the bank system code. Spell it out in the plan, character-for-character, and
say which it is — a builder who infers it from the bank code introduces a bug that does not
error.

An unresolvable value resolves to ordinal `0` (`Manual`): the bank system imports cleanly and
then routes every file through `CTS-CB Manual Import`, with nothing logged anywhere. ABN AMRO
hides this from anyone copying it, because `value(9; ABNAMRO)` happens to equal its bank code.

The same value name is also required in `Files/Bank/{CODE}.json` under
`CTS-CB Bank System Mapping2` → `"Supported Communication"`. Both must match exactly, so lock
the spelling once in the design doc rather than leaving each file to be filled in separately.

## How to find the reference bank's real config

Don't assume — look it up. For the reference bank, read its setup-JSON entries (use
`setup-files-investigate` patterns) to see its actual allowed file types, default formats, and
payment methods, then base the new bank's `SETUP_DATA_REQUIRED` on that real config plus the
new bank's Swagger/vendor docs.
