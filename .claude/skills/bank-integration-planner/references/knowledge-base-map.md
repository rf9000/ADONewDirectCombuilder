# Knowledge-Base Map

Each domain planner reads the kept knowledge skills below (they were retained precisely to be the planners' reference base — do not duplicate their content into the planner prompts). Planners cite the specific pattern/file they rely on.

## Authentication planner
- **Primary:** `.claude/skills/new-bank-communication/` — `references/auth-patterns.md` (the 3 patterns: OAuth+refresh / SFTP-agreement / external-wrapper), `references/swagger-mapping.md`, `references/implementation-checklist.md`.
- **Supporting:** `.claude/skills/async-flow-patterns/` (OAuth auth polling), `.claude/skills/request-header-mapping/` (request-header building), `.claude/skills/swagger-api-reader/` (reading the API contract).

## Export planner
- **Primary:** `.claude/skills/bank-communication-operations/references/export-patterns.md` (SendPayment + HandleRequestIDResponse, payment-batch-id extraction, status update).
- **Supporting:** `.claude/skills/async-flow-patterns/`, `.claude/skills/request-header-mapping/`, `.claude/skills/swagger-api-reader/`, `.claude/skills/setup-files-investigate/` (allowed **export** file types + default formats — `Files/Bank System - Export/{code}.json`, `Files/Bank/{code}.json`).

## Import planner
- **Primary:** `.claude/skills/bank-communication-operations/references/import-patterns.md` (Import + DoImportCall, custom error rules, response decoding, optional CAMT.053 account statement).
- **Supporting:** `.claude/skills/async-flow-patterns/`, `.claude/skills/request-header-mapping/`, `.claude/skills/swagger-api-reader/`, `.claude/skills/setup-files-investigate/` (allowed **import** file types + ISO codes — `Files/Bank System - Import/{code}.json`).

## Assisted-setup planner
- **Primary:** `.claude/skills/bank-system-setup-wizard/` (the 6 ownership rules, conflict resolution, `references/data-model.md`, `references/scenarios.md`) + `.claude/skills/new-bank-communication/references/setup-wizard-patterns.md`.
- **Supporting:** `.claude/skills/assisted-setup-wizard/` (NavigatePage step visibility, `SetupBankStep` delegation via `IAssisted Bank Account Setup`), `.claude/skills/setup-files-investigate/` (bank-system definition + payment methods the wizard registers — `Files/Bank System/{code}.json`).

## Interface decisions (all planners)
- `references/interface-decisions.md` is the source of truth for the four interfaces that have a `DefaultImplementation` on the enum — **default unless a cited reason forces an override**:
  - `IIsAuthenticationValid` → default `CTS-CB DefaultIsAuthValid`
  - `ICommunicationTypeSpecificUrlValue` → default `CTS-CB Default ComTypeUrlValue`
  - `IGetImportDictionary` → default `CTS-CB GetImportDict. Default` (production: API or Agrmnt)
  - `ICleanUpBankAccData` → default `CTS-CB DefCleanUpBankAccData` (no-op)
- Each planner records its default-vs-override calls in the fragment's `INTERFACE_DECISIONS` block; `ICleanUpBankAccData` is consolidated at assembly from every fragment's `ONBOARDING_FIELDS_WRITTEN`.

## Shared facts (all planners)
- **Read `references/setup-data-model.md` first.** It tells you which of a bank's behaviors are **setup-JSON config** (allowed file types, default formats, payment methods, validations) or **runtime `BankAccComSetup`** choices vs what this planner actually plans (AL objects + `Bank`/`Bank Account` fields). Do **not** plan an AL object or table field for setup-file config — that's a `needless-object` defect.
- A new bank = one value in `base-application/Bank Communication/Enums/CommunicationType.Enum.al`, whose `Implementation` block maps each interface to a bank-specific (or shared) codeunit. **Omit the line for any interface left on its `DefaultImplementation`.** The enum-registration edit is a single shared-file task and belongs to the **final** wave.
- Most interfaces live in `base-application/Bank Communication/Interfaces/`. Core: `ICommunicationType Auth/Export/Import`. Setup: `IAssisted Bank Account Setup`, `IAuthenticationItem`. URL: `ICommunicationTypeSpecificUrlValue`. Response: `IResponseExportHandling`, `IResponseAuthHandling`. Lifecycle: `ICleanUpBankAccData`. **Exception:** `IIsAuthenticationValid` lives in `base-application/Authentication/Interfaces/`.
- Object-name convention: `CTS-CB <Bank> <Role>` (e.g. `CTS-CB Rabobank Auth`). Files under `base-application/Bank Communication/Codeunits/{Authentication,AuthenticationItem,Export,Import,ImportDictionary,...}` and `base-application/Setup/{Codeunits,Pages/BankSystemPages}`.

## Overlap caveats
- `async-flow-patterns` and `request-header-mapping` describe mechanisms reused by auth/export/import. Cite them once; don't re-explain polling or header mapping in every fragment.
- `assisted-setup-wizard` (generic NavigatePage architecture) and `bank-system-setup-wizard`/`setup-wizard-patterns.md` (bank-specific) are complementary — the setup planner uses both.
