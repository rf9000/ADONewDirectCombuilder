# Bank System Setup - Complete Data Model Architecture

## Payment Method Code Flow Architecture

### Full Table Relationship Diagram

```
┌─────────────────────────────────────────────────────────────────┐
│  CTS-CB Bank System                                             │
│  Primary Key: Code                                              │
│  Example: "RABOBANK", "DANSKE", "NORDEA"                        │
│  Purpose: Defines available bank systems                        │
└──────────────┬──────────────────────────────────────────────────┘
               │ Bank System Code
               │
               ▼
┌─────────────────────────────────────────────────────────────────┐
│  CTS-CB Bank System Pmt. Mth. (Table 71553584)                  │
│  Primary Key: Bank System Code + Payment Method Code (20)       │
│  Links bank systems to their supported payment methods          │
│                                                                  │
│  Key Fields:                                                    │
│  - Bank System Code: Links to CTS-CB Bank System                │
│  - Payment Method Code (20): Links to CTS-CB Payment Method     │
│  - Batch Payments: Boolean                                      │
│  - File Name Template: Text[250]                                │
│  - Import Folder: Text[250]                                     │
│  - Export Folder: Text[250]                                     │
└──────────────┬──────────────────────────────────────────────────┘
               │ Payment Method Code (20 chars)
               │
               ▼
┌─────────────────────────────────────────────────────────────────┐
│  CTS-CB Payment Method (Table 71553580)                         │
│  Primary Key: Code + Sender Country + Recipient Country         │
│  Master list of all payment method definitions                  │
│                                                                  │
│  Key Fields:                                                    │
│  - Code (10): Short identifier (SEPA, BTI, Manual, etc.)        │
│  - Payment Method Code (20): Full concatenated code             │
│  - Credit Transaction: Boolean (true = Direct Debit)            │
│  - Sender Country/Region: Code[10]                              │
│  - Recipient Country/Region: Code[10]                           │
│  - Transfer Mode: Option (Direct, File)                         │
└──────────────┬──────────────────────────────────────────────────┘
               │ Code (10 chars)
               │
               ▼
┌─────────────────────────────────────────────────────────────────┐
│  Payment Method (Business Central Standard + Extension)         │
│  Primary Key: Code                                              │
│  User-visible payment methods in Business Central               │
│                                                                  │
│  Extended Fields:                                                │
│  - CTS-CB Payment Method Code: Links to CTS-CB Payment Method   │
│  - Standard BC fields (Description, Bal. Account Type, etc.)    │
└─────────────────────────────────────────────────────────────────┘
```

---

## Table Specifications

### CTS-CB Bank System
**Purpose:** Bank system definitions
**Table Number:** Not specified in source
**Primary Key:** Code

| Field | Type | Length | Description |
|-------|------|--------|-------------|
| Code | Code | 20 | Unique bank system identifier |
| Description | Text | 100 | Human-readable name |
| Enabled | Boolean | - | System active status |

---

### CTS-CB Bank System Pmt. Mth.
**Purpose:** Links bank systems to their supported payment methods
**Table Number:** 71553584
**Primary Key:** Bank System Code + Payment Method Code

| Field | Type | Length | Description |
|-------|------|--------|-------------|
| Bank System Code | Code | 20 | Link to CTS-CB Bank System |
| Payment Method Code | Code | 20 | Link to CTS-CB Payment Method |
| Batch Payments | Boolean | - | Supports batching |
| File Name Template | Text | 250 | Export file naming pattern |
| Import Folder | Text | 250 | Import directory path |
| Export Folder | Text | 250 | Export directory path |
| Transfer Mode | Option | - | Direct or File |

**Key Relationships:**
- Foreign Key: Bank System Code → CTS-CB Bank System.Code
- Foreign Key: Payment Method Code → CTS-CB Payment Method."Payment Method Code"

---

### CTS-CB Payment Method
**Purpose:** Master list of all payment method definitions
**Table Number:** 71553580
**Primary Key:** Code + Sender Country + Recipient Country

| Field | Type | Length | Description |
|-------|------|--------|-------------|
| Code | Code | 10 | Short identifier (user-facing) |
| Payment Method Code | Code | 20 | Full concatenated identifier |
| Credit Transaction | Boolean | - | true = Direct Debit, false = Payment |
| Sender Country/Region | Code | 10 | Sender country code |
| Recipient Country/Region | Code | 10 | Recipient country code |
| Transfer Mode | Option | - | Direct, File |
| Description | Text | 100 | Method description |

**Critical Business Logic:**
- `Credit Transaction = true`: Method is categorized as Direct Debit
- `Credit Transaction = false`: Method is categorized as Payment
- `Payment Method Code`: Concatenated from Code + Country codes

---

### Payment Method (BC Standard + Extension)
**Purpose:** Standard Business Central payment methods
**Table Number:** BC Standard
**Primary Key:** Code

| Field | Type | Length | Description |
|-------|------|--------|-------------|
| Code | Code | 10 | Payment method code |
| Description | Text | 100 | User-visible description |
| CTS-CB Payment Method Code | Code | 10 | Extension field linking to CTS-CB |
| Bal. Account Type | Option | - | BC standard field |
| Bal. Account No. | Code | 20 | BC standard field |

**Extension Pattern:**
- Table Extension adds `CTS-CB Payment Method Code` field
- Links BC payment methods to Continia payment methods

---

### CTS-CB Bank Acc. Com. Setup (BankAccComSetup)
**Purpose:** Stores wizard configuration results
**Table Number:** Not specified in source
**Primary Key:** Bank System Code + Type

| Field | Type | Length | Description |
|-------|------|--------|-------------|
| Bank System Code | Code | 20 | Link to bank system |
| Type | Option | - | Payment, Direct Debit, Account Statement |
| Enabled | Boolean | - | Active/Inactive status |
| Transfer Mode | Option | - | Direct or File |
| Payment Methods | Text | 2048 | Comma-separated payment method codes |

**Critical Constraints:**
- Each payment method appears in only one active record
- Account Statement: Only one system can have Enabled = true
- Records are never deleted, only set to Enabled = false

---

## Code Length Specifications

### Why Two Code Lengths?

**10-Character Code:**
- User-facing identifier
- Stored in BC Payment Method table
- Examples: "SEPA", "BTI", "Manual", "DD-b2b"
- Used for display and user selection

**20-Character Code:**
- Internal system identifier
- Concatenated from base code + country codes
- Ensures uniqueness across regions
- Used for system lookups and relationships

### Code Concatenation Pattern

```al
PaymentMethodCode := Code + SenderCountry + RecipientCountry;
// Example: "SEPA" + "DK" + "DK" = "SEPADKDK"
```

---

## Payment Method Type Determination

### Credit Transaction Flag Logic

```al
procedure DeterminePaymentType(PaymentMethod: Record "CTS-CB Payment Method"): Text
begin
    if PaymentMethod."Credit Transaction" then
        exit('Direct Debit')
    else
        exit('Payment');
end;
```

### Type Categories

1. **Payment** (Credit Transaction = false)
   - BTI (Bank Transfer International)
   - Manual
   - SEPA (Single Euro Payments Area)
   - BTD (Bank Transfer Domestic)

2. **Direct Debit** (Credit Transaction = true)
   - DD-b2b (Direct Debit Business-to-Business)
   - DD-insta (Direct Debit Instant)
   - DD-core (Direct Debit Core)

3. **Account Statement** (Special Type)
   - No payment methods
   - Always exists for all bank systems
   - Only one active at a time

---

## Lookup Patterns

### Finding Payment Methods for a Bank System

```al
procedure GetBankSystemPaymentMethods(BankSystemCode: Code[20])
var
    BankSystemPmtMth: Record "CTS-CB Bank System Pmt. Mth.";
    CTSPaymentMethod: Record "CTS-CB Payment Method";
    BCPaymentMethod: Record "Payment Method";
begin
    // Step 1: Find all payment methods for bank system
    BankSystemPmtMth.SetRange("Bank System Code", BankSystemCode);
    if BankSystemPmtMth.FindSet() then
        repeat
            // Step 2: Get payment method details
            if CTSPaymentMethod.Get(BankSystemPmtMth."Payment Method Code") then
                // Step 3: Find BC payment method for display
                if BCPaymentMethod.Get(CTSPaymentMethod.Code) then
                    // Process payment method
        until BankSystemPmtMth.Next() = 0;
end;
```

### Checking Ownership

```al
procedure IsPaymentMethodOwned(PaymentMethodCode: Code[20]): Boolean
var
    BankAccComSetup: Record "CTS-CB Bank Acc. Com. Setup";
begin
    BankAccComSetup.SetRange(Enabled, true);
    BankAccComSetup.SetFilter("Payment Methods", '*' + PaymentMethodCode + '*');
    exit(not BankAccComSetup.IsEmpty());
end;
```

---

## BankAccComSetup Table Evolution

### State Transitions

1. **Initial State**: Empty table
2. **After First System**: All types enabled for System 1
3. **After Conflict Resolution**: Mixed ownership, some disabled entries
4. **After Migration**: Old system all disabled, new system all enabled

### Payment Methods Field Format

The Payment Methods field stores comma-separated payment method codes:
- Example: "BTI,Manual,SEPA"
- Empty when no methods assigned
- Updated during conflict resolution

### Record Lifecycle

```
Created (Enabled=true)
    ↓
Conflict Detected
    ↓
User Chooses Different Owner
    ↓
Set Enabled=false (Never Delete)
    ↓
Preserved for History/Audit
```

---

## Filtering and Performance Considerations

### Efficient Lookups

```al
// Good: Filter first, then check
BankAccComSetup.SetRange(Enabled, true);
BankAccComSetup.SetRange(Type, BankAccComSetup.Type::Payment);
if not BankAccComSetup.IsEmpty() then
    // Process

// Avoid: Loading all records
if BankAccComSetup.FindSet() then
    repeat
        if BankAccComSetup.Enabled then
            // Less efficient
    until BankAccComSetup.Next() = 0;
```

### SetLoadFields for Large Operations

```al
// When only checking specific fields
BankAccComSetup.SetLoadFields(Enabled, "Payment Methods");
if BankAccComSetup.Get(BankSystemCode, Type) then
    // Only loaded fields are available
```

Note: Setup tables typically don't require SetLoadFields due to small size

---

## Common Implementation Patterns

### Adding Payment Method to System

```al
procedure AddPaymentMethodToSystem(BankSystemCode: Code[20]; PaymentMethod: Code[20])
var
    BankAccComSetup: Record "CTS-CB Bank Acc. Com. Setup";
    PaymentType: Option Payment,"Direct Debit","Account Statement";
begin
    // Determine type based on Credit Transaction flag
    PaymentType := DeterminePaymentType(PaymentMethod);

    if BankAccComSetup.Get(BankSystemCode, PaymentType) then begin
        if BankAccComSetup."Payment Methods" = '' then
            BankAccComSetup."Payment Methods" := PaymentMethod
        else
            BankAccComSetup."Payment Methods" += ',' + PaymentMethod;
        BankAccComSetup.Modify(true);
    end;
end;
```

### Removing Payment Method from System

```al
procedure RemovePaymentMethodFromSystem(BankSystemCode: Code[20]; PaymentMethod: Code[20])
var
    BankAccComSetup: Record "CTS-CB Bank Acc. Com. Setup";
    NewMethods: Text;
begin
    // Implementation to remove method from comma-separated list
    // Never delete the record, only update the list
end;
```

---

## Validation Rules

### Must Always Hold True

1. **Single Ownership Rule**
   ```al
   Each payment method code appears in exactly one Enabled=true record
   ```

2. **Account Statement Uniqueness**
   ```al
   Only one BankAccComSetup record with Type="Account Statement" and Enabled=true
   ```

3. **No Orphaned Methods**
   ```al
   All payment methods in BankAccComSetup must exist in base tables
   ```

4. **Preservation Rule**
   ```al
   Records with Enabled=false are never deleted
   ```

5. **Type Consistency**
   ```al
   Payment method type must match Credit Transaction flag
   ```