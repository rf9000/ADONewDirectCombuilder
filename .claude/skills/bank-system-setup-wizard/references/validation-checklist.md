# Bank System Setup Wizard - Validation Checklist

## Pre-Modification Verification

Before making any changes to the Bank System Setup Wizard logic, verify:

### Current State Analysis
- [ ] Document current BankAccComSetup table contents
- [ ] List all active payment method assignments
- [ ] Identify any inactive (Enabled=false) records
- [ ] Note Account Statement ownership
- [ ] Record all bank systems currently configured

### Code Review Checklist
- [ ] Understand existing conflict detection logic
- [ ] Review payment method ownership checks
- [ ] Examine BankAccComSetup update procedures
- [ ] Check Account Statement handling
- [ ] Verify record preservation logic (no deletes)

### Dependency Check
- [ ] Identify all procedures that read BankAccComSetup
- [ ] Find all payment method assignment logic
- [ ] Locate conflict resolution page implementation
- [ ] Check for event subscribers on wizard tables
- [ ] Review any upgrade codeunits

---

## Post-Change Validation Requirements

After implementing changes, validate all aspects:

### Compilation and Static Analysis
```powershell
# Run AL compilation with all analyzers
al compile /project:"C:\GeneralDev\AL\Continia Banking Master\Continia Banking\base-application" /analyzer:"{path}\Microsoft.Dynamics.Nav.CodeCop.dll;{path}\Microsoft.Dynamics.Nav.AppSourceCop.dll;{path}\Microsoft.Dynamics.Nav.UICop.dll" /packagecachepath:"C:\GeneralDev\AL\Continia Banking Master\Continia Banking\.alpackages" /ruleset:"C:\GeneralDev\AL\Continia Banking Master\Continia Banking\Rules.ruleset.json" /continuebuildonerror:+
```

- [ ] No compilation errors
- [ ] All analyzer warnings reviewed
- [ ] SOLID principles maintained
- [ ] No unused variables (AA0137)

### Scenario Testing (All 4 Must Pass)

#### Scenario 1: Initial Setup
- [ ] First bank system configures without conflicts
- [ ] All payment methods assigned correctly
- [ ] Account Statement automatically added
- [ ] All records have Enabled = true

#### Scenario 2: Partial Overlap
- [ ] Conflict resolution page appears
- [ ] Only overlapping methods shown
- [ ] User choices properly implemented
- [ ] Non-overlapping methods auto-assigned
- [ ] Previous system records updated correctly

#### Scenario 3: Third System
- [ ] Conflicts detected with existing systems
- [ ] Payment method transfers work
- [ ] Account Statement single active constraint
- [ ] Inactive records preserved

#### Scenario 4: Complete Migration
- [ ] All methods transfer to new system
- [ ] Old system fully deactivated
- [ ] Records preserved (not deleted)
- [ ] New system fully functional

### Data Integrity Checks

```al
// Run these validation procedures after each scenario
procedure ValidateDataIntegrity()
begin
    ValidateSingleOwnership();
    ValidateAccountStatementUniqueness();
    ValidateNoOrphanedMethods();
    ValidateInactiveRecordsPreserved();
    ValidatePaymentMethodTypes();
end;
```

- [ ] Each payment method has exactly one active owner
- [ ] Only one Account Statement is active
- [ ] All payment methods in BankAccComSetup exist in base tables
- [ ] No records were deleted (check record count)
- [ ] Payment method types match Credit Transaction flag

---

## Testing Procedures

### Unit Test Requirements

```al
codeunit 50000 "Bank Setup Wizard Tests"
{
    Subtype = Test;

    [Test]
    procedure TestSingleOwnershipConstraint()
    // Verify payment method can't be active in multiple systems

    [Test]
    procedure TestAccountStatementUniqueness()
    // Verify only one Account Statement can be active

    [Test]
    procedure TestRecordPreservation()
    // Verify records are never deleted, only deactivated

    [Test]
    procedure TestConflictDetection()
    // Verify overlapping methods are detected correctly

    [Test]
    procedure TestConflictResolution()
    // Verify user choices are properly implemented
}
```

### Integration Test Coverage

1. **Wizard Flow Tests**
   - [ ] Complete wizard for new system
   - [ ] Cancel wizard mid-process
   - [ ] Re-run wizard for existing system
   - [ ] Wizard with no payment methods

2. **Conflict Resolution Tests**
   - [ ] All methods transfer to new system
   - [ ] All methods stay with old system
   - [ ] Mixed choices (some transfer, some stay)
   - [ ] Account Statement transfer

3. **Edge Case Tests**
   - [ ] System with only Account Statement
   - [ ] System with 50+ payment methods
   - [ ] Duplicate payment method codes
   - [ ] Invalid payment method references

### Manual Testing Protocol

1. **Setup Test Environment**
   ```al
   // Clear test company data
   // Initialize base payment methods
   // Prepare test bank systems
   ```

2. **Execute Test Scenarios**
   - Run each of the 4 scenarios in sequence
   - Document actual vs expected results
   - Screenshot conflict resolution pages
   - Export BankAccComSetup table after each step

3. **Validate Results**
   - Compare table states with expected outcomes
   - Verify UI displays correct information
   - Check audit trail/change log
   - Confirm no data loss

---

## Common Validation Queries

### Check Single Ownership
```al
procedure CheckSingleOwnership(): Boolean
var
    BankAccComSetup: Record "CTS-CB Bank Acc. Com. Setup";
    PaymentMethods: List of [Text];
    Method: Text;
begin
    BankAccComSetup.SetRange(Enabled, true);
    if BankAccComSetup.FindSet() then
        repeat
            // Parse payment methods and check for duplicates
        until BankAccComSetup.Next() = 0;
end;
```

### Verify Account Statement
```al
procedure VerifyAccountStatementUniqueness(): Boolean
var
    BankAccComSetup: Record "CTS-CB Bank Acc. Com. Setup";
begin
    BankAccComSetup.SetRange(Type, BankAccComSetup.Type::"Account Statement");
    BankAccComSetup.SetRange(Enabled, true);
    exit(BankAccComSetup.Count() = 1);
end;
```

### Count Preserved Records
```al
procedure CountPreservedRecords(): Integer
var
    BankAccComSetup: Record "CTS-CB Bank Acc. Com. Setup";
begin
    BankAccComSetup.SetRange(Enabled, false);
    exit(BankAccComSetup.Count());
end;
```

---

## Performance Validation

- [ ] Wizard completes in < 5 seconds for typical setup
- [ ] Conflict resolution page loads in < 2 seconds
- [ ] No timeout errors with 100+ payment methods
- [ ] Efficient database queries (check SQL profiler)

---

## Regression Prevention

### Before Release Checklist
- [ ] All 4 scenarios tested in clean environment
- [ ] All 4 scenarios tested with existing data
- [ ] Edge cases validated
- [ ] Performance benchmarks met
- [ ] No breaking changes to public APIs
- [ ] Documentation updated if needed

### Continuous Validation
- [ ] Add to automated test suite
- [ ] Include in CI/CD pipeline
- [ ] Monitor production telemetry
- [ ] Track error rates post-deployment

---

## Emergency Rollback Plan

If issues are discovered post-deployment:

1. **Immediate Actions**
   - [ ] Disable wizard UI if critical issue
   - [ ] Restore BankAccComSetup from backup
   - [ ] Document all affected systems

2. **Data Recovery**
   - [ ] Identify corrupted records
   - [ ] Restore payment method assignments
   - [ ] Verify Account Statement ownership
   - [ ] Re-enable systems as needed

3. **Root Cause Analysis**
   - [ ] Review which validation was missed
   - [ ] Update test cases to prevent recurrence
   - [ ] Document lessons learned

---

## Sign-off Requirements

Before marking implementation complete:

**Developer Verification:**
- [ ] All checklist items completed
- [ ] Test results documented
- [ ] Code reviewed by peer

**QA Verification:**
- [ ] Independent scenario testing
- [ ] Edge cases validated
- [ ] Performance acceptable

**Business Verification:**
- [ ] Wizard behavior matches requirements
- [ ] User experience acceptable
- [ ] Migration scenarios work correctly