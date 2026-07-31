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
| **Allowed file types** the bank system accepts for **export** | Bank System - Export | `Files/Bank System - Export/{BankSystemCode}.json` |
| **Allowed file types** the bank system accepts for **import** | Bank System - Import | `Files/Bank System - Import/{BankSystemCode}.json` |
| Payment methods, field validations, validation sets | Bank System | `Files/Bank System/{BankSystemCode}.json` |
| ISO bank transaction codes | Import Setup | `Files/ImportSetup.json` |
| Bank closing days (holidays) | Export Setup | `Files/ExportSetup.json` |

## The rule

> **Do NOT plan an AL object — or a `Bank`/`Bank Account` table field, or a hard-coded
> constant — for something that is setup-file config or a runtime `BankAccComSetup` choice.**

**Worked example (the mistake this doc exists to prevent):** "the bank accepts PAIN.001 for
export and CAMT.053 for import." Those **allowed file-type values are setup-JSON config**
(`Bank System - Export/{code}.json` and `Bank System - Import/{code}.json`), looked up at
runtime — not an enum, not a codeunit branch, not a `Bank` table field. The export/import
codeunits *read* the configured file type; they don't *define* it. Planning a per-bank object
to "select the file type" is a `needless-object` defect.

## A new bank needs new setup-JSON entries too

Because column 1 is real deliverable data, the design doc must **list the setup-JSON entries
the new bank requires** (bank-system code, allowed file types per direction, default formats,
payment methods) — not just AL objects. Each planner reports these in its fragment's
`SETUP_DATA_REQUIRED` block; assembly consolidates them into the design doc's **Setup Data**
section. Authoring those JSON files lives in the sibling setup-files repo and is downstream of
this plan — but the plan must name them so nothing is silently missed.

## How to find the reference bank's real config

Don't assume — look it up. For the reference bank, read its setup-JSON entries (use
`setup-files-investigate` patterns) to see its actual allowed file types, default formats, and
payment methods, then base the new bank's `SETUP_DATA_REQUIRED` on that real config plus the
new bank's Swagger/vendor docs.
