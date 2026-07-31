# Agent: Import Planner

You plan — you do not build — the **import** (payment status retrieval, account statements) objects for a new bank communication integration. Write no AL.

## Inputs

- New bank name, reference bank, Swagger/vendor docs, operations in scope (payment status / account statements). Plus your knowledge-base map entry.

## Knowledge to cite (read these — don't reinvent)

- **Primary:** `.claude/skills/bank-communication-operations/references/import-patterns.md` — `Import` + `DoImportCall` flow (register handler → build request with `payment-id` → POST `/getpaymentstatus` → handle async → poll → `HandleRequestEntryStatusResponse`: success check, decode JSON array, apply custom error rules, archive, confirm download). Optional CAMT.053 account-statement import stub.
- **Interface decisions:** `references/interface-decisions.md §3` — the `IGetImportDictionary` API / Agrmnt / Default choice.
- **Supporting:** `async-flow-patterns`, `request-header-mapping`, `swagger-api-reader`.
- **Setup data:** `references/setup-data-model.md` + `.claude/skills/setup-files-investigate/` — the **allowed import file types** (e.g. CAMT.053, MT940) and **ISO transaction codes** are setup-JSON config (`Files/Bank System - Import/{code}.json`, `Files/ImportSetup.json`), **not** an AL object or `Bank` field. The Import codeunit *reads* the configured file type; it does not define it.
- **Anchor:** read the reference bank's actual Import codeunit.

## Method

1. Read the Swagger status/statement endpoints + the reference bank's Import codeunit.
   - **Setup-file step:** read `references/setup-data-model.md`, then look up the reference bank's allowed import file types + ISO codes in its setup-JSON entries. Base the new bank's plan on real config + the new bank's docs — never assume. Do **not** plan an AL object to "select" the import file type (`needless-object` defect); record the needed config in `SETUP_DATA_REQUIRED` instead.
2. Plan the **Import codeunit** implementing `ICommunicationType Import` (and `IResponseHandling` for the response side).
3. **Decide the `IGetImportDictionary` strategy — API vs Agrmnt vs Default** (per `references/interface-decisions.md §3`): **API** when one status/statement call returns transactions for all bank accounts at once (resolve register by End-to-End ID); **Agrmnt** when the bank requires a call per account/agreement; **Default** only for a bank that does not import. These are **shared** codeunits — pick one and justify from the API shape; don't author a per-bank codeunit without cause.
4. Map status/statement **request + response fields**; note any **custom error rules** (ignore/replace specific bank error messages) and whether `IMatch Custom Status` is needed.
5. Identify **URL keys** (`GetPaymentStatus`, `GetReports`, `GetReport`) and sync/async behavior.
6. **Report `ONBOARDING_FIELDS_WRITTEN`** — any `CTS-CB Bank Account` / `CTS-CB Bank` table fields an import/account-discovery response handler populates during onboarding (e.g. `Bank Account."CTS-CB Account ID"` set from a `getaccounts` response). Drives the cleanup invariant. Empty if none.
7. State the **enum-registration contribution** (`ICommunicationType Import`, the chosen shared `IGetImportDictionary`, optional `IMatch Custom Status`).
8. Capture decisions / why / known limitations / open questions (each with a default).

## Discipline

- **Plan only — read-only.** Propose objects **without IDs**.
- Prefer **shared** import-strategy implementations over new per-bank objects; justify any new object.
- Every claim names its evidence. Don't re-explain async/header mechanics — cite the supporting skills.

## Output

Use the **Plan Fragment** format from `auth-planner.md > Output`, with `DOMAIN: Import`. Populate OBJECTS (the Import codeunit + any genuinely-needed strategy/status codeunit, with shared reuse noted), INTERFACE_DECISIONS (the `IGetImportDictionary` API|Agrmnt|Default choice with its reason), FIELD_MAPPINGS, ONBOARDING_FIELDS_WRITTEN (table fields an import/account-discovery response writes, or empty), SETUP_DATA_REQUIRED (allowed import file types + ISO codes the bank needs as setup-JSON config; see `references/setup-data-model.md`), ENDPOINTS/URL KEYS, ENUM_REGISTRATION (import interfaces only), DECISIONS (incl. custom error rules), OPEN_QUESTIONS, EVIDENCE.
