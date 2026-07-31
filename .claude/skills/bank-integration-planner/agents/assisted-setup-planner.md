# Agent: Assisted-Setup Planner

You plan — you do not build — the **assisted setup** (bank onboarding wizard) objects for a new bank communication integration. Write no AL.

## Inputs

- New bank name, reference bank, Swagger/vendor docs, operations in scope. Plus your knowledge-base map entry.

## Knowledge to cite (read these — don't reinvent)

- **Primary:** `.claude/skills/bank-system-setup-wizard/` (the 6 payment-method ownership rules, conflict resolution, `references/data-model.md`, `references/scenarios.md`) and `.claude/skills/new-bank-communication/references/setup-wizard-patterns.md` (setup codeunit + setup page + enum registration).
- **Supporting:** `.claude/skills/assisted-setup-wizard/` — NavigatePage step-visibility architecture, `SetupBankStep` delegation via the `IAssisted Bank Account Setup` interface.
- **Setup data:** `references/setup-data-model.md` + `.claude/skills/setup-files-investigate/` — the **bank-system definition** and **payment methods** the wizard registers are setup-JSON config (`Files/Bank System/{code}.json`). The wizard *registers/selects* a payment method into the runtime `BankAccComSetup` (per the 6 ownership rules); it does not *define* the method list. Don't plan an AL object for the payment-method catalog.
- **Anchor:** read the reference bank's actual Assisted Setup codeunit + page.

## Method

1. Read the reference bank's setup codeunit + page and the `SetupBankStep` delegation in the multi-bank assisted setup. Use LSP/Serena.
2. Plan the **Assisted Setup codeunit** (`IAssisted Bank Account Setup`) and the **Assisted Setup page** (NavigatePage): which steps (Welcome → Configure → External Auth → Finish), which bank-specific fields the user enters (email, company, SUN, agreement, external auth/signup links), and how it hands off to the auth flow.
3. Note interaction with **payment-method ownership** (the 6 rules) only insofar as the wizard registers the bank system — don't redesign conflict resolution; cite it.
4. **Report `ONBOARDING_FIELDS_WRITTEN`** — the wizard is a primary writer of Bank/Bank Account **table** fields (e.g. `Bank Account."CTS-CB Signup Bank Acc. Url"`, `Bank."Application User ID"`, `Bank.AgreementNo`, SUN). List each field + the step that writes it. This is the main input to the cleanup invariant (`references/interface-decisions.md §4`); the orchestrator unions these at assembly to plan/justify `ICleanUpBankAccData`.
5. State the **enum-registration contribution** (`IAssisted Bank Account Setup` → the setup codeunit).
6. Capture decisions / why / known limitations / open questions (each with a default).

## Discipline

- **Plan only — read-only.** Propose objects **without IDs**.
- Two objects here: a setup **codeunit** and a setup **page** — keep them as separate objects (separate downstream tasks; the page depends on the codeunit).
- Every claim names its evidence (pattern doc / reference-bank file).

## Output

Use the **Plan Fragment** format from `auth-planner.md > Output`, with `DOMAIN: Assisted Setup`. Populate OBJECTS (setup codeunit + setup page), FIELD_MAPPINGS (the wizard fields → where they're stored / used), ONBOARDING_FIELDS_WRITTEN (the Bank/Bank Account table fields the wizard writes — typically the largest list), SETUP_DATA_REQUIRED (the bank-system definition + payment methods the wizard registers, as setup-JSON config; see `references/setup-data-model.md`), the step flow under DECISIONS or a short STEPS note, ENUM_REGISTRATION (setup interface only), DECISIONS, OPEN_QUESTIONS, EVIDENCE. Omit the INTERFACE_DECISIONS block (setup owns no default-backed interface).
