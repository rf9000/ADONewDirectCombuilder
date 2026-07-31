# Bank Authentication Implementation Checklist

Step-by-step checklist for implementing a new bank authentication codeunit.

## Table of Contents

- [Phase 1: Pre-Implementation](#phase-1-pre-implementation)
- [Phase 2: Create Codeunit Shell](#phase-2-create-codeunit-shell)
- [Phase 3: Implement Core Logic](#phase-3-implement-core-logic)
- [Phase 4: Configuration](#phase-4-configuration)
- [Phase 5: Testing](#phase-5-testing)
- [Phase 6: Code Review Checklist](#phase-6-code-review-checklist)
- [Common Pitfalls](#common-pitfalls)
- [Quick Reference: File Locations](#quick-reference-file-locations)

## Phase 1: Pre-Implementation

### Gather Requirements
- [ ] Obtain Swagger/OpenAPI specification for the bank API
- [ ] Use `swagger-api-reader` skill to understand endpoints and schemas
- [ ] Identify authentication type (OAuth, Agreement, Certificate)
- [ ] Document required Bank table fields for this bank
- [ ] List all endpoints needed (auth, refresh, status)

### Determine Pattern
- [ ] **OAuth with refresh?** → Use `ICommunicationTypeAuthGetToken` + `IResponseAuthHandling`
- [ ] **Agreement-based?** → Use `ICommunicationType Auth` + `IIsAuthenticationValid`
- [ ] **Simple wrapper?** → Use `ICommunicationType Auth` only

### Reserve Object ID
- [ ] Use `mcp__objid__allocate_id` to reserve codeunit ID
- [ ] Verify ID is in correct range for base-application

---

## Phase 2: Create Codeunit Shell

### File Setup
- [ ] Create file: `base-application/Bank Communication/Codeunits/Authentication/{BankName}Auth.Codeunit.al`
- [ ] Set correct object ID and name with `CTS-CB` prefix
- [ ] Add `Access = Internal;`
- [ ] Declare interface implementations

### Required Procedures
- [ ] `EstablishConnection` - Initial authentication
- [ ] `RefreshConnection` - Token refresh (can be empty)
- [ ] `GetStatus` - Check authentication status
- [ ] `SetCommunicationTypeAuth` - Self-registration helper

### Optional Procedures (based on pattern)
- [ ] `GetToken` - For OAuth callback flow
- [ ] `IsAuthenticationEntryDetailsValid` - For validation interface
- [ ] `HandleErrorResponse` - For error handling interface
- [ ] `GetAuthenticationItem` - Retrieve stored auth as JSON

---

## Phase 3: Implement Core Logic

### EstablishConnection
- [ ] Generate TracingID
- [ ] Build request JSON (use `RequestHeader` procedure)
- [ ] Set URL using `IHttpFactory.GetUrlInterface().GetUrl()`
- [ ] Execute HTTP POST
- [ ] Log tracing ID
- [ ] Handle response (success → store auth, error → archive)

### Request Header Building
- [ ] Create `RequestHeader` procedure
- [ ] Get `RequestHeaderMapping` for bank system
- [ ] Use `Populate` to extract Bank table values
- [ ] Use `BuildRequest.CreateRootValues` for standard fields
- [ ] Use `BuildRequest.CreateAuthentication` if needed
- [ ] Serialize JSON and return

### Response Handling
- [ ] Check `IsSuccessStatusCode()`
- [ ] Parse JSON response
- [ ] Handle async pattern (extract `status-entry-id` if present)
- [ ] Extract authentication tokens/references
- [ ] Store in Authentication Entry
- [ ] **CRITICAL: Call `Commit()` after storing tokens**

### Error Handling
- [ ] Create `HandleErrorResponse` procedure
- [ ] Extract error text via `GetErrorTexts`
- [ ] Archive error to File Archive
- [ ] Throw error with meaningful message

---

## Phase 4: Configuration

### URL Configuration
- [ ] Add URL keys for new endpoints (e.g., `BCCreateAgreement`)
- [ ] Verify URL pattern includes `{bank}` substitution placeholder

### Request Header Mapping
- [ ] Add entries to `CTS-CB Request Header Mapping` table
- [ ] Map Bank table fields to JSON property names
- [ ] Test mapping produces correct JSON output

### Bank System Setup
- [ ] Ensure Communication Type is correctly configured
- [ ] Verify bank system code is used consistently

---

## Phase 5: Testing

### Unit Tests
- [ ] Test `EstablishConnection` with mock HTTP factory
- [ ] Test `GetStatus` returns correct enum values
- [ ] Test `RefreshConnection` timing logic (if OAuth)
- [ ] Test error handling paths
- [ ] Test `IsAuthenticationEntryDetailsValid` (if implemented)

### Integration Tests
- [ ] Test full auth flow against test environment
- [ ] Verify Authentication Entry is created correctly
- [ ] Verify tokens are stored with correct expiration
- [ ] Test token refresh works before expiry
- [ ] Test error responses are archived correctly

### Edge Cases
- [ ] Test with already-authenticated bank (should skip)
- [ ] Test with expired tokens (should trigger refresh)
- [ ] Test with invalid credentials (should error gracefully)
- [ ] Test async polling timeout handling

---

## Phase 6: Code Review Checklist

### Interface Compliance
- [ ] All interface methods implemented
- [ ] Method signatures match interface exactly
- [ ] No missing `var` modifiers on parameters

### Error Handling
- [ ] All error paths archive to File Archive
- [ ] No silent failures (errors are thrown or logged)
- [ ] JSON parse failures handled via `CannotReadJSON`

### Security
- [ ] No tokens logged in plain text
- [ ] Authentication stored via secure `SetAuthentication` method
- [ ] No hardcoded credentials or URLs

### Performance
- [ ] `SetLoadFields` used before `Get`/`Find` calls
- [ ] No unnecessary database reads in loops
- [ ] Commit only when necessary (after token storage)

### Code Style
- [ ] Follows AL coding patterns from `.claude/rules/`
- [ ] Early exit pattern used (no deep nesting)
- [ ] Variable names match object names
- [ ] Labels used for error messages (not inline strings)

---

## Common Pitfalls

### Token Not Persisting
- **Cause:** Missing `Commit()` after `SetAuthentication`
- **Fix:** Always commit immediately after storing tokens

### Status Always NotReady
- **Cause:** `IsAuthenticationEntryDetailsValid` returns false
- **Fix:** Check validation logic, ensure unique-reference/token is stored

### Refresh Not Triggering
- **Cause:** `DoRefreshToken` timing calculation wrong
- **Fix:** Verify `RefreshTokenExpiresIn` is set correctly (seconds × 1000)

### Async Polling Fails
- **Cause:** `status-entry-id` not logged
- **Fix:** Call `LogRequestEntryID` after extracting ID from response

### Wrong URL Called
- **Cause:** URL key mismatch or missing configuration
- **Fix:** Verify URL key in `GetUrl()` matches configuration

---

## Quick Reference: File Locations

| Component | Path |
|-----------|------|
| Auth codeunit | `base-application/Bank Communication/Codeunits/Authentication/` |
| Interfaces | `base-application/Bank Communication/Interfaces/` |
| Build Request | `base-application/Bank Communication/Codeunits/BuildRequest.Codeunit.al` |
| JSON Functions | `base-application/Utility/Codeunits/JsonFunctions.Codeunit.al` |
| Tests | `base-application-test/Authentication/` |
