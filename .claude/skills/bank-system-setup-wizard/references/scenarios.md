# Bank System Setup Wizard - Detailed Scenarios

This document contains the complete step-by-step scenarios for validating Bank System Setup Wizard behavior. Each scenario shows exact table states and expected outcomes.

## Step 1: Setup of Bank System 1

### Initial Configuration
**Bank System 1 Payment Methods:**
| Type | Methods | Notes |
|------|---------|-------|
| Payment | BTI, Manual, SEPA | 3 total |
| Direct Debit | DD-b2b | credit transfer = true |
| Account Statement | (default) | always added |

### Expected BankAccComSetup Table After Wizard
| # | System | Type | Enabled | Transfer | Payment Methods |
|---|--------|------|---------|----------|-----------------|
| 1 | Bank System 1 | Payment | ✅ | Direct | BTI, Manual, SEPA |
| 2 | Bank System 1 | Account Statement | ✅ | Direct | – |
| 3 | Bank System 1 | Direct Debit | ✅ | Direct | DD-b2b |

**Validation Points:**
- All payment methods belong to Bank System 1
- All types are enabled
- Account Statement is automatically added
- No conflicts (first system setup)

---

## Step 2: Setup of Bank System 2 with Partial Overlap

### Initial State
Bank System 1 already configured (from Step 1)

### Bank System 2 Configuration
**Bank System 2 Payment Methods:**
| Type | Methods | Notes |
|------|---------|-------|
| Payment | BTI, Manual, SEPA, BTD | overlaps partially with System 1 |
| Direct Debit | DD-b2b, DD-insta | DD-b2b overlaps with System 1 |

### Conflict Resolution Page
| Row | Type | Payment Method | Old System | New System | User Choice |
|-----|------|---------------|------------|------------|-------------|
| 1 | Payment | BTI | Bank System 1 | Bank System 2 | **Bank System 1** |
| 2 | Payment | Manual | Bank System 1 | Bank System 2 | **Bank System 2** |
| 3 | Payment | SEPA | Bank System 1 | Bank System 2 | **Bank System 1** |
| 4 | Direct Debit | DD-b2b | Bank System 1 | Bank System 2 | **Bank System 1** |
| 5 | Account Statement | (none) | Bank System 1 | Bank System 2 | **Bank System 2** |

### Expected BankAccComSetup Table After Resolution
| # | System | Type | Enabled | Transfer | Payment Methods |
|---|--------|------|---------|----------|-----------------|
| 1 | Bank System 1 | Payment | ✅ | Direct | BTI, SEPA |
| 2 | Bank System 2 | Payment | ✅ | Direct | Manual, BTD |
| 3 | Bank System 1 | Direct Debit | ✅ | Direct | DD-b2b |
| 4 | Bank System 2 | Direct Debit | ✅ | Direct | DD-insta |
| 5 | Bank System 1 | Account Statement | ❌ | Direct | – |
| 6 | Bank System 2 | Account Statement | ✅ | Direct | – |

**Validation Points:**
- Payment methods split based on user choices
- Both systems remain active for different types
- Bank System 1 Account Statement deactivated (not deleted)
- Each payment method has single owner
- BTD (non-overlapping) automatically assigned to Bank System 2

---

## Step 3: Setup of Bank System 3

### Initial State
- Bank System 1: Payment (BTI, SEPA), Direct Debit (DD-b2b), Account Statement (inactive)
- Bank System 2: Payment (Manual, BTD), Direct Debit (DD-insta), Account Statement (active)

### Bank System 3 Configuration
**Bank System 3 Payment Methods:**
| Type | Methods | Notes |
|------|---------|-------|
| Payment | BTI | Overlaps with Bank System 1 |
| Direct Debit | (none) | No direct debit methods |

### Conflict Resolution Page
| Row | Type | Payment Method | Old System | New System | User Choice |
|-----|------|---------------|------------|------------|-------------|
| 1 | Payment | BTI | Bank System 1 | Bank System 3 | **Bank System 3** |
| 2 | Account Statement | (none) | Bank System 2 | Bank System 3 | **Bank System 3** |

### Expected BankAccComSetup Table After Resolution
| # | System | Type | Enabled | Transfer | Payment Methods |
|---|--------|------|---------|----------|-----------------|
| 1 | Bank System 1 | Payment | ✅ | Direct | SEPA |
| 2 | Bank System 3 | Payment | ✅ | Direct | BTI |
| 3 | Bank System 2 | Payment | ✅ | Direct | Manual, BTD |
| 4 | Bank System 1 | Direct Debit | ✅ | Direct | DD-b2b |
| 5 | Bank System 2 | Direct Debit | ✅ | Direct | DD-insta |
| 6 | Bank System 1 | Account Statement | ❌ | Direct | – |
| 7 | Bank System 2 | Account Statement | ❌ | Direct | – |
| 8 | Bank System 3 | Account Statement | ✅ | Direct | – |

**Validation Points:**
- BTI transferred from Bank System 1 to Bank System 3
- Account Statement transferred from Bank System 2 to Bank System 3
- All previous Account Statement entries set to inactive
- Bank System 1 still active but with reduced payment methods
- No Direct Debit entry for Bank System 3 (none configured)

---

## Step 4: Complete System Migration

### Initial State
Bank System 1 freshly configured with:
| Type | Methods | Notes |
|------|---------|-------|
| Payment | BTI, Manual, SEPA | 3 payment methods |
| Direct Debit | DD-b2b | 1 direct debit method |
| Account Statement | (default) | always present |

### Bank System 2 Configuration (Same Methods)
**Bank System 2 Payment Methods:**
| Type | Methods | Notes |
|------|---------|-------|
| Payment | BTI, Manual, SEPA | Exact match with Bank System 1 |
| Direct Debit | DD-b2b | Exact match with Bank System 1 |
| Account Statement | (default) | always present |

### Conflict Resolution Page (Complete Overlap)
| Row | Type | Payment Method | Old System | New System | User Choice |
|-----|------|---------------|------------|------------|-------------|
| 1 | Payment | BTI | Bank System 1 | Bank System 2 | **Bank System 2** |
| 2 | Payment | Manual | Bank System 1 | Bank System 2 | **Bank System 2** |
| 3 | Payment | SEPA | Bank System 1 | Bank System 2 | **Bank System 2** |
| 4 | Direct Debit | DD-b2b | Bank System 1 | Bank System 2 | **Bank System 2** |
| 5 | Account Statement | (none) | Bank System 1 | Bank System 2 | **Bank System 2** |

### Expected BankAccComSetup Table After Complete Migration
| # | System | Type | Enabled | Transfer | Payment Methods |
|---|--------|------|---------|----------|-----------------|
| 1 | Bank System 1 | Payment | ❌ | Direct | – |
| 2 | Bank System 1 | Direct Debit | ❌ | Direct | – |
| 3 | Bank System 1 | Account Statement | ❌ | Direct | – |
| 4 | Bank System 2 | Payment | ✅ | Direct | BTI, Manual, SEPA |
| 5 | Bank System 2 | Direct Debit | ✅ | Direct | DD-b2b |
| 6 | Bank System 2 | Account Statement | ✅ | Direct | – |

**Validation Points:**
- **Bank System 1 still exists** in the table (not deleted)
- **All Bank System 1 entries are inactive** (Enabled = false)
- **Bank System 1 has 0 payment methods** (all transferred)
- **Bank System 2 owns all payment methods and types**
- Demonstrates complete migration scenario
- Useful for switching bank providers

---

## Test Case Specifications

### For Each Scenario, Verify:

1. **Before Wizard:**
   - Current BankAccComSetup state matches expected initial state
   - Payment methods exist in base tables
   - Credit Transaction flags set correctly

2. **During Conflict Resolution:**
   - All overlapping methods appear in conflict list
   - No non-overlapping methods in conflict list
   - Account Statement always included when multiple systems

3. **After Wizard Completion:**
   - Final BankAccComSetup matches expected state exactly
   - Each payment method has single active owner
   - Inactive entries preserved (not deleted)
   - Account Statement has single active system
   - Transfer mode set correctly for all entries

### Edge Cases to Test

1. **Empty Payment Methods:**
   - System with only Account Statement
   - System with no Direct Debit methods

2. **Partial Transfers:**
   - Some methods stay, some transfer
   - Mixed user choices in conflict resolution

3. **Re-running Wizard:**
   - Running wizard again for same system
   - Changing previous decisions

4. **Invalid States:**
   - Duplicate active payment methods (should be prevented)
   - Missing Account Statement (should auto-add)
   - Orphaned payment methods (should be detected)

---

## Regression Testing Checklist

After any code modification, run all scenarios and verify:

- [ ] Scenario 1: Initial setup works without conflicts
- [ ] Scenario 2: Partial overlap resolves correctly
- [ ] Scenario 3: Method transfer between systems works
- [ ] Scenario 4: Complete migration preserves history
- [ ] Inactive entries never deleted
- [ ] Each payment method single owner constraint
- [ ] Account Statement single active constraint
- [ ] Conflict resolution page shows correct items
- [ ] User choices properly implemented
- [ ] Table consistency maintained throughout

---

## Common Issues and Solutions

### Payment Method Not Transferring
**Check:**
- Conflict resolution choice implementation
- Payment method list update logic
- Enabled flag changes

### Account Statement Multiple Active
**Check:**
- Previous owner deactivation
- Single active validation
- Conflict resolution for Account Statement type

### Lost Payment Methods
**Check:**
- Never delete records rule
- Proper ownership transfer
- Payment method list concatenation

### Conflict Not Detected
**Check:**
- Overlap detection filters
- Active vs inactive consideration
- Payment method comparison logic