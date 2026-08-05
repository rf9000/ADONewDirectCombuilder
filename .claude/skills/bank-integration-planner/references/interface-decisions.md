# Interface Decisions — default vs override

Four bank-communication interfaces each have a `DefaultImplementation` on
`base-application/Bank Communication/Enums/CommunicationType.Enum.al`, and **most banks
correctly use the default**. For each, decide *default vs per-bank override* deliberately and
cite the reason. Default-first: choose the default unless a fact from the Swagger / reference
bank forces an override. Over-planning (a per-bank object where the default works) is a defect
the verifier flags as `needless-object`; under-planning (default where a bank-specific marker is
required, or a missing cleanup) is flagged as `wrong-default-override` / `cleanup-gap`.

Enum `DefaultImplementation` lines (verify against the enum):

| Interface | Default codeunit | Default behavior |
|---|---|---|
| `CTS-CB IIsAuthenticationValid` | `CTS-CB DefaultIsAuthValid` | valid if `Value <> ''` and (access expiry > 0 **or** certificate expiration set) |
| `CTS-CB ICommunicationTypeSpecificUrlValue` | `CTS-CB Default ComTypeUrlValue` | returns `BankSystemCode` unchanged (all 3 overloads) |
| `CTS-CB IGetImportDictionary` | `CTS-CB GetImportDict. Default` | no-op (empty dictionary) |
| `CTS-CB ICleanUpBankAccData` | `CTS-CB DefCleanUpBankAccData` | no-op (clears nothing) |

---

## 1. `IIsAuthenticationValid` — is the stored auth still valid?

Interface: `base-application/Authentication/Interfaces/IIsAuthenticationValid.Interface.al`
(note: **`Authentication/Interfaces/`**, not `Bank Communication/Interfaces/`).
`procedure IsAuthenticationEntryDetailsValid(AuthenticationEntry: Record "CTS-CB Authentication Entry"; Value: Text; BankSystemCode: Code[30]): Boolean`

**Default suffices when** validity is simply "a token/credential exists and has not expired" —
the default checks `Value <> ''` plus access-token expiry or certificate expiration. Most banks
use it.

**Override (bank-specific codeunit) when** validity hinges on a **non-standard marker** the
default can't see:
- Specific JSON fields must all be present — `CTS-CB RabobankIsAuthValid` (access-token,
  refresh-token, expires-in, refresh-token-expires-in, consent-id).
- Certificate/key per protocol standard — `CTS-CB PSD2IsAuthValid`, `CTS-CB EBICSIsAuthValid`.
- A company/agreement marker, e.g. SWEDBank validity is
  `AuthenticationEntry."BC Company Info Id" <> 0` (see memory `project_swedbank_auth_validity`).

Some banks implement this **on the Auth codeunit itself** (the Auth codeunit also implements
`IIsAuthenticationValid`) rather than a separate codeunit — e.g. `CTS-CB DNB Auth`,
`CTS-CB Bizcuit Auth`. Either is fine; pick what the reference bank does.

---

## 2. `ICommunicationTypeSpecificUrlValue` — what value fills the URL template

Interface: `base-application/Bank Communication/Interfaces/ICommunicationTypeSpecificUrlValue.Interface.al`.
Three overloads, called with increasing context:
```
GetUrlValue(BankSystemCode)                                              // base
GetUrlValue(BankSystemCode, TransactionType)                            // payment/import routing
GetUrlValue(BankSystemCode, TransactionType, Conversion, FileType)      // file conversion only
```
The returned text is substituted into the URL template:
`StrSubstNo(GetUrl('Accounts'), …GetUrlValue(BankSystemCode))`. The full 4-arg overload is
consumed only by `Conversion/Codeunits/FileConversion.Codeunit.al`.

**Derive the choice from the API docs**, by category:

| Category | Use when | Example impl |
|---|---|---|
| **E — Default (pass-through)** | the URL segment **equals** the bank-system value (the value the comm-type already carries) | `Default ComTypeUrlValue` (returns `BankSystemCode`) |
| **A — Fixed bank token, no branch** | the URL segment is a fixed identifier that **differs** from the bank-system value, same for every call | `Yapily` → `'YAPILY'`; `BANKSapi` → `'banksapi'` |
| **B — Fixed token + `BankSystemCode` override** | fixed token for most calls, but Direct Debit / PSP calls route by the bank-system value instead | `Rabobank` → `'RABOBANK20022'`, returns `BankSystemCode` for Direct Debit/PSP. **Not ABN AMRO** — see below |
| **C — Dynamic enum-name token** | multiple banks share one platform and the URL segment is the comm-type **name**; specific transaction types still route by `BankSystemCode` | `Konfipay` (reads `BankSystem."Communication Type".Names`, overrides 5 transaction types to `BankSystemCode`) |
| **D — Dual-endpoint routing** | the bank exposes two protocols/endpoints and routing depends on Conversion + FileType + TransactionType | `BANKSapiEBICS` (`'banksapi'` for PSD2/custom-format/status flows, `BankSystemCode` for EBICS) |

**Heuristic, in order:** URL segment == comm-type/bank-system value → **E (default)**. Else a
fixed bank identifier → **A**, adding the `BankSystemCode` override for the overloads whose calls
differ (DD/PSP/conversion) → **B**. Platform-shared name → **C**. Two endpoints → **D**.

**Before classifying as A or B, compare the token to the bank-system code.** If they are
equal, every overload returns what `DefaultComTypeUrlValue` already returns and the object is
a needless-object defect — the existence of a per-bank implementation in the repo is not
evidence that one is needed.

`ABNAmroComTypeUrlValue.Codeunit.al:31` defines `ABNAMROTok = 'ABNAMROISO20022'`, byte-identical
to ABN AMRO's sole bank-system code — so despite appearing in the repo as a category-B
implementation, it is functionally **E**, including on the Direct-Debit/PSP branch. Copying it
for a new bank whose route segment also equals its bank-system code adds an object that does
nothing. Verified 2026-08-05.

Reference: `RabobankComTypeUrlValue` (B), `YapilyComTypeUrlValue` (A), `KonfipayComTypeUrlValue`
(C), `BANKSapiEBICSUrlValue` (D), `DefaultComTypeUrlValue` (E),
`ABNAmroComTypeUrlValue` (looks like B, behaves as E).

This value feeds **every** endpoint (auth, export, import), so the auth planner owns the object
but export/import must use the same chosen value when planning their URL keys.

---

## 3. `IGetImportDictionary` — how a status/statement response maps back to payment registers

Interface: `base-application/Bank Communication/Interfaces/IGetImportDictionary.Interface.al`.
`procedure GetImportDictionary(EndToEndID: Code[35]; BankAccountNo: Code[20]; var DictionaryOfPaymentRegisterNoAndBankAccNo: Dictionary of [Integer, Code[20]])`

Three **shared** codeunits — pick one, do not author a per-bank codeunit without a real reason:

- **`CTS-CB GetImportDict. API`** — one import call returns transactions for **all** bank accounts
  at once; resolves the register by looking up the Payment Ledger Entry by End-to-End ID. Used by
  API-style banks (Bizcuit, Rabobank, ABN AMRO, Yapily variants, BANKSapi, Citibank, Konfipay,
  AccessPay).
- **`CTS-CB GetImportDict. Agrmnt`** — import is **per bank account / per agreement** (one request
  per account); de-dupes by checking whether the account is already in the dictionary. Used by
  agreement-style banks (DNB, Nordea, DanskeBank, SEB, SWED, BankConnect, Handelsbanken, TietoEvry,
  Manual).
- **`CTS-CB GetImportDict. Default`** — no-op; only correct for a bank that does not import.

**Decision:** API when a single status/statement call returns all accounts; Agrmnt when the bank
requires a call per account/agreement. A real import bank is never left on Default. Codeunits live
in `base-application/Bank Communication/Codeunits/ImportDictionary/`.

---

## 4. `ICleanUpBankAccData` — reverse onboarding's table writes when auth is removed

Interface: `base-application/Bank Communication/Interfaces/ICleanUpBankAccData.Interface.al`.
`procedure ClearBankAccountData(BankCode: Code[30]; TargetCompanyName: Text[30])`.
Caller: `Authentication/Codeunit/Authentication.Codeunit.al > ClearBankAccountDataForAuth`,
resolved from the enum and fired when an **authentication entry is deleted**, once per company.

**Required when** onboarding (the assisted-setup wizard **or** an API response handler) writes
**table fields** on `CTS-CB Bank Account` or `CTS-CB Bank` — e.g. `"CTS-CB Account ID"`,
`"CTS-CB Signup Bank Acc. Url"`, `"CTS-CB Unique ID"`, `Bank."Application User ID"`,
`Bank."Direct Signup Link"`, `Bank.AgreementNo`, `Bank."Signup Link"`. Without cleanup the wizard
can't re-establish the connection after the auth entry is deleted (it skips `EstablishConnection`
gated on a stale field).

**Not required when** all auth state lives in IsolatedStorage / the Authentication Entry — those
are removed with the auth entry. Such a bank keeps the no-op default; do **not** create a needless
cleanup codeunit.

**Invariant the plan must satisfy:**
- Every Bank/Bank Account **table** field written during onboarding is cleared by the cleanup.
- The cleanup clears **only** this bank system's fields — never fields a co-resident bank system
  owns. `BnkApiPSD2ClnUpBnkAcc` deliberately leaves `Bank.AgreementNo`/`Bank.PDF` (EBICS-owned)
  untouched so PSD2 and EBICS can coexist on the same bank.

References: `CTS-CB BizcuitClnUpBnkAccData` (simple — two Bank Account fields),
`CTS-CB YapilyClnUpBnkAccData` / `CTS-CB BnkApiPSD2ClnUpBnkAcc` (multi-table + coexistence). All
under `base-application/Bank Communication/Codeunits/Authentication/`. Because the written fields
are decided across the auth/import/assisted-setup domains, each planner reports them in
`ONBOARDING_FIELDS_WRITTEN`; the orchestrator unions them at assembly to finalize this object.
