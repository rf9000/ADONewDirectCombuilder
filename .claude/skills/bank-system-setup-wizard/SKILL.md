---
name: bank-system-setup-wizard
description: Authoritative guide for Continia Banking's Bank System Setup Wizard behavior, conflict resolution logic, and BankAccComSetup table management. Use this skill when modifying wizard logic, debugging payment method conflicts, or validating system setup configurations. Critical for ensuring multiple bank systems coexist correctly with proper payment method ownership.
---

# Bank System Setup Wizard Guide

## Purpose & When to Use This Skill

**Activate this skill when:**
- Modifying the Bank System Setup Wizard logic
- Debugging payment method ownership conflicts
- Validating BankAccComSetup table states
- Implementing bank system conflict resolution
- Adding new bank systems or payment methods
- Troubleshooting why payment methods appear/disappear
- Migrating from one bank system to another
- Reviewing expected wizard behavior before changes

**Key Areas:** Bank System Setup, Payment Method Management, Conflict Resolution, BankAccComSetup Table

## The 6 Critical Rules (NEVER VIOLATE)

1. **Each payment method can belong to only one bank system at a time**
2. **Each type (Payment, Direct Debit, Account Statement) can exist in multiple systems**, but ownership of individual methods is unique
3. **When a system loses ownership of a type or method, it is not deleted** — it is set inactive (Enabled = false)
4. **Account Statement always exists for all systems**, but only one can be active at a time
5. **Adding or changing a system must not override previous system logic** or break previously resolved setups
6. **The wizard result is fully reflected in the BankAccComSetup table** — which stores the enabled/disabled state, transfer mode, and owned payment methods per system

## Conflict Resolution Workflow

When setting up a new bank system with overlapping payment methods:

### 1. Detection Phase
```al
// System scans for overlapping payment methods
// Checks existing BankAccComSetup for active assignments
// Builds conflict list for user resolution
```

### 2. Conflict Resolution Page
Displays overlapping items requiring user decision:
- **Payment Methods**: Individual methods that exist in multiple systems
- **Direct Debit Methods**: Credit transfer methods requiring ownership
- **Account Statement**: Always requires single active owner

### 3. User Decision Implementation
```al
// For each conflict:
// - User chooses which system keeps ownership
// - Old owner: Set Enabled = false (preserve record)
// - New owner: Set Enabled = true, update Payment Methods list
// - Never delete records, only deactivate
```

### 4. Validation
- Each payment method assigned to exactly one system
- Account Statement has single active owner
- All systems have valid BankAccComSetup entries
- Inactive entries preserved for history

## Quick Data Model Overview

```
Bank System → Bank System Pmt. Mth. → Payment Method → BC Payment Method
     ↓              ↓                      ↓                   ↓
  "RABOBANK"    Links methods         20-char code        10-char code
               to bank system      (internal lookup)    (user-visible)
```

**Key Tables:**
- `CTS-CB Bank System`: Bank system definitions
- `CTS-CB Bank System Pmt. Mth.` (71553584): Method-to-system mapping
- `CTS-CB Payment Method` (71553580): Payment method definitions
- `Payment Method` (BC + Extension): User-visible methods

**Critical Fields:**
- `Credit Transaction` (boolean): Determines Payment vs Direct Debit
- `Payment Method Code` (20-char): Internal unique identifier
- `Code` (10-char): User-facing payment method code

## Validation Checklist

Before modifying wizard logic:
- [ ] Review all 4 scenarios in `references/scenarios.md`
- [ ] Understand payment method code flow in `references/data-model.md`
- [ ] Verify changes preserve the 6 critical rules
- [ ] Check BankAccComSetup table consistency

After modifications:
- [ ] Test all 4 scenarios completely
- [ ] Verify conflict resolution works correctly
- [ ] Confirm inactive entries are preserved
- [ ] Validate single ownership per payment method
- [ ] Check Account Statement single active constraint
- [ ] Run AL compilation with analyzers

## Common Implementation Patterns

### Checking Payment Method Ownership
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

### Transferring Ownership
```al
procedure TransferOwnership(FromSystem: Code[20]; ToSystem: Code[20]; PaymentMethod: Code[20])
var
    FromSetup, ToSetup: Record "CTS-CB Bank Acc. Com. Setup";
begin
    // Deactivate old owner (never delete)
    if FromSetup.Get(FromSystem, ...) then begin
        FromSetup.Enabled := false;
        FromSetup.RemovePaymentMethod(PaymentMethod);
        FromSetup.Modify(true);
    end;

    // Activate new owner
    if ToSetup.Get(ToSystem, ...) then begin
        ToSetup.Enabled := true;
        ToSetup.AddPaymentMethod(PaymentMethod);
        ToSetup.Modify(true);
    end;
end;
```

### Detecting Conflicts
```al
procedure DetectConflicts(NewSystem: Code[20]): List of [Text]
var
    Conflicts: List of [Text];
    // Check each payment method in new system
    // Compare against active entries in BankAccComSetup
    // Add to conflicts list if already owned
begin
    // Implementation details in full codebase
end;
```

## Using Reference Documentation

For detailed information, consult the reference files:

### `references/scenarios.md`
Complete step-by-step walkthroughs of:
- Step 1: Initial bank system setup
- Step 2: Second system with partial overlap
- Step 3: Third system taking specific methods
- Step 4: Complete system migration

Use when: Validating expected behavior, creating test cases, understanding complex interactions

### `references/data-model.md`
Full technical architecture including:
- Complete table relationships diagram
- Field specifications and constraints
- Payment method code flow (10-char vs 20-char)
- Table primary keys and lookups

Use when: Understanding data flow, debugging lookup issues, implementing new features

### `references/validation-checklist.md`
Comprehensive testing procedures:
- Pre-modification verification steps
- Post-change validation requirements
- Test case specifications
- Common error scenarios

Use when: Preparing for changes, validating implementations, troubleshooting issues

## Critical Warnings

⚠️ **NEVER delete BankAccComSetup records** - Always set Enabled = false
⚠️ **NEVER allow duplicate active payment methods** - Enforce single ownership
⚠️ **NEVER skip conflict resolution** - User must decide ownership
⚠️ **ALWAYS preserve inactive entries** - Required for audit trail
⚠️ **ALWAYS validate against all 4 scenarios** - Prevents regression

## Quick Troubleshooting

**Payment method not appearing:**
- Check BankAccComSetup for active ownership
- Verify Credit Transaction flag matches type
- Confirm payment method exists in base tables

**Conflict resolution not triggering:**
- Verify overlap detection logic
- Check existing active assignments
- Ensure proper type categorization

**Account Statement issues:**
- Confirm only one active per system
- Check previous owner was deactivated
- Verify type is always added to new systems

## Integration Points

This skill complements:
- `/docs/al/coding-standards.md` - AL coding conventions
- `/docs/al/solid-principles.md` - SOLID implementation patterns
- `/docs/architecture/bank-communication.md` - Bank system architecture
- CLAUDE.md project instructions - General development guidelines

When using this skill, ensure you also follow the project's SOLID principles and AL coding standards for maintainable implementations.