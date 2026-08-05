# Phase 0 — Required Inputs

Gather and confirm these before planning. Missing items are fine to start with — Phase 1's `validate-information` agent decides which gaps are *blocking* vs which become Open Questions.

| Input | Required? | Notes |
|-------|-----------|-------|
| **New bank name** | yes | PascalCase, no spaces (e.g. `AccessPay`, `Konfipay`). Becomes the object-name stem (`CTS-CB <Name> Auth`). |
| **Reference bank** | yes | An existing bank in the codebase whose pattern is closest. Anchors the planners. See the pattern map below. |
| **Swagger / OpenAPI** | strongly | Path or URL. Without it, endpoint/field planning is guesswork — likely a blocking gap. |
| **Vendor docs** | optional | Onboarding flows, auth specifics, agreement/SUN concepts. |
| **Operations in scope** | yes | Any of: payments (PAIN.001), direct debit (PAIN.008), account statements (CAMT.053), payment status. Drives which interfaces are needed. |
| **Auth type** | if known | OAuth+refresh / SFTP-agreement / certificate / external-wrapper. If unknown, the auth planner infers it from Swagger and flags confidence. |
| **Output path** | yes | Where to write the design doc + task list JSON. Default: a scratch path beside the inputs. |

## Reference-bank → pattern hints

(From the existing knowledge skills — confirm against the actual Swagger, don't assume.)

| Reference bank | Auth pattern | Notes |
|----------------|--------------|-------|
| **Rabobank** | OAuth with refresh tokens | Nordic-style; async auth polling; `IBankAccountAtThirdParty`. |
| **AccessPay** | SFTP agreement-based | No token expiry; agreement status checks; single unique-reference key. |
| **Yapily** | External wrapper | Minimal auth codeunit; OAuth handled externally; interactive export variants. |
| **DNB / Nordea / DanskeBank** | OAuth, Nordic | Common Nordic onboarding flow. |
| **Konfipay** | German EBICS-alternative | — |
| **Bizcuit** | Dutch accounting integration | Custom status matching (`IMatch Custom Status`). |

## Minimal object manifest (what a bank usually needs)

Use this to sanity-check that the planners proposed a complete set (≈8–12 objects):

- `CTS-CB <Name> Auth` — `ICommunicationType Auth` (+ `IResponseAuthHandling` for OAuth)
- `CTS-CB <Name>AuthItem` — `IAuthenticationItem`
- `CTS-CB <Name> Export` — `ICommunicationType Export` + `IResponseExportHandling`
- `CTS-CB <Name> Import` — `ICommunicationType Import`
- `CTS-CB <Name> Assisted Setup` (codeunit) — `IAssisted Bank Account Setup`
- `CTS-CB <Name> Assisted Setup` (page) — NavigatePage onboarding
- **Enum registration** — a value in `CommunicationType.Enum.al` wiring all the above
- **`IGetImportDictionary`** — always a deliberate choice (not optional): bind the shared `GetImportDict. API` (one call returns all accounts) or `GetImportDict. Agrmnt` (per account/agreement). See `references/interface-decisions.md §3`.
- **Default unless a cited reason forces an override** (each has a `DefaultImplementation` — see `references/interface-decisions.md`):
  - `CTS-CB <Name>IsAuthValid` — `IIsAuthenticationValid` only when validity needs a non-standard marker; else the default.
  - `CTS-CB <Name>ComTypeUrlValue` — `ICommunicationTypeSpecificUrlValue` only when the URL segment differs from the bank-system value; else the default.
  - `CTS-CB <Name>ClnUpBnkAccData` — `ICleanUpBankAccData` **required when** onboarding writes `Bank`/`Bank Account` table fields (clear exactly those); else the no-op default.
- Optional: `IBankAccountAtThirdParty`, `IMatch Custom Status`.

Object IDs for base-application: each bank consumes ~8–12.

**Do not take a range from this document — measure first.** Ranges are shared team
state and fill up; a range named here was accurate when written and will not stay
that way. Measured 2026-08-05: `71553575–71553874` had **1** free ID left and
`72282325–72282424` had **8** — both effectively exhausted, and both were still
listed here as "primary" and "extended". `72918625–72918824` had 157 free.

Check occupancy against the current tree before choosing, and reserve through the
AL Object ID Ninja MCP rather than picking by hand — a fabricated ID collides with
another developer's in-flight reservation, and nothing detects that until build.

**Never invent an ID to keep planning moving.** If reservation is unavailable,
emit the sentinel `0` in `objects[].id`, make every object-creating task depend on
the reservation task, and raise it as a blocking question. A plan with invented
IDs looks complete and is not.

### A Ninja-issued ID is not automatically free — verify it against the tree

Ninja tracks what *it* has issued, not what exists. IDs hand-assigned in a PR
without going through Ninja stay invisible to it, so it will happily reissue them.

Observed 2026-08-05: Ninja issued `97138` for an `export-test` codeunit, already
occupied in-tree by `CTS-PE Pmt Sts Srch Conv UT`. Cause: PR 52349 added codeunits
97138–97163 with hand-assigned IDs that were never registered. Writing the issued
ID into a file would have produced a duplicate-ID build failure with a cause
nowhere near the symptom.

**After every reservation, grep the tree for that ID scoped to the object type**
(`codeunit 97138`, `page 97138` — the same number is legal across types) before
writing it into a file.

**When an issued ID is occupied:** Ninja issues strictly `+1` and has no
assign-specific-ID call, so walk it upward until you reach one genuinely free in
the tree. **Keep the intermediate reservations rather than releasing them** — they
are the ones already in use, and holding them makes Ninja's index match reality
instead of leaving the same trap for the next developer. Report the repair in the
plan: which IDs were absorbed, and that the team should re-sync Ninja's
consumed-ID index for that app. The underlying defect is hand-assignment outside
Ninja, not the reservation.
