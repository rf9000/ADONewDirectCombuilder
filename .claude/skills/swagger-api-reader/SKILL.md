---
name: swagger-api-reader
description: Guide for reading Continia Banking internal API Swagger/OpenAPI documentation. Explains the async status-polling pattern, response schema locations, common request fields, and how to interpret endpoint documentation. Use this skill when implementing API integrations or understanding bank API contracts.
---

# Continia Banking Swagger API Reader Guide

## Purpose & When to Use This Skill

**Activate this skill when:**
- Reading Swagger/OpenAPI JSON files for Continia Banking APIs
- Implementing new bank API integrations in AL
- Understanding the async request-response pattern
- Finding actual response schemas (not just StatusEntryIdResponse)
- Debugging API integration issues
- Mapping API contracts to AL code structures

**Key Areas:** API Integration, Async Patterns, Schema Navigation, Bank Communication

## The Async Status-Polling Pattern (CRITICAL)

Most Continia Banking API endpoints use an **async pattern** where the initial call does NOT return the actual response directly.

### The Pattern Flow

```
1. Call action endpoint (e.g., /send, /getaccounts)
   └─> Returns: StatusEntryIdResponse { "status-entry-id": "guid" }

2. Poll status endpoint with the status-entry-id
   └─> Call: /status with { "status-entry-id": "guid", ... }
   └─> Returns: Actual response with status + content

3. Optionally clean up
   └─> Call: /deletestatus to remove the status entry
```

### Example Flow

```
POST /public-api/v1/{bank}/send
  Request: YapilySendRequest (payment data)
  Response: { "status-entry-id": "3fa85f64-5717-4562-b3fc-2c963f66afa6" }

POST /public-api/v1/{bank}/status
  Request: { "status-entry-id": "3fa85f64-5717-4562-b3fc-2c963f66afa6", ... }
  Response: {
    "status": "Completed",
    "content": { /* actual send response data */ }
  }
```

### Status Values

The `status` field in the response payload indicates processing state:
- `Unknown` - Status cannot be determined
- `Requested` - Request received, not yet processing
- `Pending` - Waiting for external action
- `InProgress` - Currently being processed
- `Completed` - Successfully completed (check content)
- `Failed` - Processing failed (check content for error details)

## Finding Actual Response Schemas

**DO NOT** look at the endpoint's direct response for actual data. Most endpoints return `StatusEntryIdResponse`.

**DO** look at the `/status` endpoint's response schema, specifically the `content` field which uses `oneOf`:

```
Location in Swagger JSON:
components → schemas → {Bank}ResponsePayload → properties → content → oneOf
```

### Response Type Mapping

The `content` field in the response payload contains different schemas based on which endpoint was originally called:

| Original Endpoint | Content Schema |
|-------------------|----------------|
| /gettoken | {Bank}GetTokenResponse |
| /extendconsent | {Bank}ExtendConsentResponse |
| /gettransactions | {Bank}TransactionsResponse |
| /getaccounts | {Bank}AccountsResponse |
| /send | Varies by bank (check oneOf) |
| /getpaymentstatus | Varies by bank |

### Schema Location Pattern

```json
"components": {
  "schemas": {
    "{Bank}ResponsePayload": {
      "properties": {
        "status": { "enum": ["Unknown", "Requested", "Pending", "InProgress", "Completed", "Failed"] },
        "content": {
          "oneOf": [
            { "$ref": "#/components/schemas/{Bank}GetTokenResponse" },
            { "$ref": "#/components/schemas/{Bank}TransactionsResponse" },
            { "$ref": "#/components/schemas/{Bank}AccountsResponse" },
            // ... other response types
          ]
        }
      }
    }
  }
}
```

## Common Request Fields

Most request schemas include these standard fields:

### Required Fields
| Field | Type | Description |
|-------|------|-------------|
| `transaction-id` | uuid | Unique ID for this transaction (for tracking/idempotency) |
| `company-guid` | uuid | BC company identifier |
| `bc-user-name` | string | Business Central user making the request |

### Optional Common Fields
| Field | Type | Description |
|-------|------|-------------|
| `compression` | boolean | Whether payload content is compressed |
| `psu-ip-address` | string | Payment Service User IP (for PSD2 compliance) |
| `psu-corporate-id` | string | Corporate PSU identifier |
| `psu-id` | string | Individual PSU identifier |

### Authentication Object
Many requests require an `authentication` object:
```json
{
  "authentication": {
    "institution": "bank-identifier",
    "application-user-id": "user-id",
    "authentication-items": {
      "token": "consent-token"
    }
  }
}
```

## Endpoint Categories

### Synchronous Endpoints
These return actual data directly (no status polling needed):

| Endpoint | Purpose |
|----------|---------|
| `/conversion` | File format conversion (CAMT, PAIN, MT940, etc.) |
| `/gettokencallback` | OAuth callback handler (external use only) |
| `/deletestatus` | Clean up status entries |

### Asynchronous Endpoints (require status polling)

| Endpoint | Purpose |
|----------|---------|
| `/gettoken` | Initiate OAuth/consent flow |
| `/extendconsent` | Extend existing consent |
| `/send` | Send payments to bank |
| `/gettransactions` | Fetch bank transactions |
| `/getaccounts` | Fetch bank accounts |
| `/getpaymentstatus` | Check payment execution status |

## Error Response Schemas

### ValidationProblemDetails (HTTP 400)
Validation errors with field-level details:
```json
{
  "type": "error-type-uri",
  "title": "Validation Failed",
  "status": 400,
  "detail": "One or more validation errors occurred",
  "errors": {
    "field-name": ["Error message 1", "Error message 2"]
  }
}
```

### ApiError (HTTP 404, 415, 500)
General API errors:
```json
{
  "message": "Error summary",
  "details": "Detailed error information",
  "errors": ["Error 1", "Error 2"]
}
```

## Bank Name Substitution

The path segment `{bank}` (e.g., "yapily" in the example) is substituted with the actual bank/provider name:

```
/public-api/v1/yapily/send    → Yapily provider
/public-api/v1/rabobank/send  → Rabobank direct
/public-api/v1/nordea/send    → Nordea direct
```

Schema names follow the same pattern:
- `YapilyResponsePayload` → `RabobankResponsePayload`
- `YapilySendRequest` → `NordeaSendRequest`

## Reading Strategy

When given a new Swagger file, follow this order:

### 1. Identify the Bank/Provider
Look at `info.title` and path prefixes to identify the bank name.

### 2. List All Endpoints
Scan `paths` to understand available operations.

### 3. Categorize Endpoints
- Which return `StatusEntryIdResponse`? → Async (need polling)
- Which return direct data? → Sync

### 4. Find Response Schemas
Navigate to `components.schemas.{Bank}ResponsePayload.content.oneOf` to find all possible response types.

### 5. Map Request Schemas
For each endpoint, trace the `$ref` in `requestBody.content.application/json.schema` to find the full request structure.

### 6. Identify Enums
Check `components.schemas` for enum types (file types, payment types, statuses, etc.).

## AL Implementation Notes

When implementing API calls in AL:

### Status Polling Pattern
```al
procedure CallBankAPI(): Boolean
var
    StatusEntryId: Guid;
    ResponseStatus: Enum "Bank Response Status";
begin
    // 1. Call action endpoint
    StatusEntryId := CallActionEndpoint(RequestPayload);

    // 2. Poll for completion
    repeat
        Sleep(PollingInterval);
        ResponseStatus := PollStatus(StatusEntryId);
    until ResponseStatus in [ResponseStatus::Completed, ResponseStatus::Failed];

    // 3. Process result
    if ResponseStatus = ResponseStatus::Completed then
        ProcessSuccessResponse(StatusEntryId)
    else
        ProcessFailedResponse(StatusEntryId);

    // 4. Clean up
    DeleteStatus(StatusEntryId);
end;
```

### JSON Field Naming
API uses kebab-case (`status-entry-id`), AL uses PascalCase. Ensure proper mapping in JSON handling.

## Quick Reference

### Finding a Field's Type
```
Path: components → schemas → {SchemaName} → properties → {fieldName} → type/enum/$ref
```

### Finding Required Fields
```
Path: components → schemas → {SchemaName} → required (array of field names)
```

### Finding Nested Object Structure
```
Follow $ref: "#/components/schemas/{NestedSchemaName}"
```

### Authentication Scheme
```
Path: components → securitySchemes → bearer
Global security: security → bearer
```

## Reference Documentation

### `references/yapily-example.md`
Complete Yapily API reference including:
- All endpoint summaries with request/response schemas
- Full PaymentRequest structure with all enums
- File type enum for conversion endpoint
- Complete flow example (gettoken → status → getaccounts → cleanup)
- Error response examples

Use when: Implementing new bank APIs, understanding schema structures, building test payloads

## Integration Points

This skill complements:
- `/docs/architecture/bank-communication.md` - Bank system architecture
- `/.claude/skills/bank-system-setup-wizard/SKILL.md` - Bank system configuration
- `/base-application/` - Core API integration codeunits
- CLAUDE.md - General development guidelines

When implementing API integrations, follow SOLID principles and the project's AL coding standards for maintainable code.
