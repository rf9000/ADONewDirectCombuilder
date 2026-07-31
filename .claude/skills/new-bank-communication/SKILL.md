---
name: new-bank-communication
description: Guide for creating new bank authentication codeunits implementing OAuth, SFTP agreement, or certificate-based auth flows. Use when (1) creating a new bank authentication codeunit, (2) implementing OAuth flows with refresh tokens, (3) mapping Swagger/OpenAPI endpoints to AL authentication code, (4) debugging authentication flow issues, or (5) adding new authentication methods to existing bank integrations. Key areas: Bank Authentication, OAuth Flows, API Integration, Interface Implementation.
---

# Bank Authentication Codeunit Development Guide

## Quick Start: Which Pattern?

| Bank Auth Type | Pattern | Interface(s) | Reference |
|----------------|---------|--------------|-----------|
| **OAuth with Refresh** | Full OAuth | `ICommunicationTypeAuthGetToken`, `IResponseAuthHandling` | [auth-patterns.md](references/auth-patterns.md#pattern-2-oauth-with-refresh-tokens-rabobank-style) |
| **SFTP Agreement** | Agreement-based | `ICommunicationType Auth`, `IIsAuthenticationValid` | [auth-patterns.md](references/auth-patterns.md#pattern-1-sftp-agreement-based-accesspay-style) |
| **OAuth (External)** | Simple wrapper | `ICommunicationType Auth` | [auth-patterns.md](references/auth-patterns.md#pattern-3-simple-wrapper-yapily-style) |
| **Certificate-based** | Direct auth | `ICommunicationType Auth` | Similar to Agreement |

## Core Authentication Flow

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                    AUTHENTICATION FLOW                                       │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  EstablishConnection:                                                       │
│  1. Generate TracingID                                                      │
│  2. Build request JSON via RequestHeader                                    │
│  3. Set URL using IHttpFactory.GetUrlInterface()                           │
│  4. Execute HTTP POST                                                       │
│  5. Handle response:                                                        │
│     - Success → store auth via SetAuthentication + Commit()                │
│     - Error → archive to File Archive + throw                              │
│                                                                             │
│  For Async APIs (OAuth):                                                    │
│  6. Extract status-entry-id                                                 │
│  7. Poll with GetAsyncRequestEntryResponse                                 │
│  8. Process final response                                                  │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

## Key Components

| Component | Purpose |
|-----------|---------|
| `CTS-CB Bank` | Bank configuration (Code, Signup Link, SUN fields) |
| `CTS-CB Authentication Entry` | Stored auth tokens (Bank Code, Unique Reference Key, Storage Entry) |
| `CTS-CB Request Header Mapping` | Field-to-JSON mapping for bank-specific fields |
| `CTS-CB Build Request` | Builds JSON with standard fields (transaction-id, company-guid) |
| `CTS-CB Populate Request Header` | Extracts values from Bank using mapping |

## Swagger → AL Mapping

| Swagger Field | AL Source/Destination |
|---------------|----------------------|
| `transaction-id` | `IHttpFactory.GetTracingIDLog().GetTracingID()` |
| `status-entry-id` | `RequestEntryIDLog.LogRequestEntryID()` |
| `authentication-items` | `AuthenticationEntry` via `SetAuthentication` |
| `expires-in` | `AccessTokenExpiresIn: Duration` (seconds × 1000) |
| `url` (signup) | `Bank."Signup Link"` |

For complete mapping details, see [swagger-mapping.md](references/swagger-mapping.md).

## Reference Documentation

### `references/auth-patterns.md`
Complete code patterns for all authentication types:
- OAuth flow with refresh tokens (Rabobank pattern)
- SFTP Agreement flow (AccessPay pattern)
- Simple wrapper pattern (Yapily pattern)
- Token refresh logic

**Use when:** Starting new implementation, understanding specific flows

### `references/swagger-mapping.md`
Quick reference for translating Swagger schemas to AL code:
- Request field → AL source mapping
- Response field → AL storage mapping
- URL key configuration
- Code snippets for common operations

**Use when:** Translating Swagger specs to AL code

### `references/implementation-checklist.md`
Step-by-step checklist covering:
- Pre-implementation requirements
- Implementation steps by phase
- Testing requirements
- Common pitfalls and fixes

**Use when:** Implementing a new bank, code review

## Critical Warnings

- **NEVER store tokens in plaintext** - Always use Authentication Entry storage
- **ALWAYS handle async patterns** - Check for `status-entry-id` in responses
- **ALWAYS validate auth before operations** - Check `AuthenticationEntryIsValid`
- **NEVER skip error archiving** - All errors must go to File Archive
- **ALWAYS Commit() after token storage** - Tokens must persist even if later operations fail

## Quick Troubleshooting

| Problem | Likely Cause | Fix |
|---------|--------------|-----|
| Auth not persisting | Missing `Commit()` | Add Commit() after SetAuthentication |
| Status always NotReady | `IsAuthenticationEntryDetailsValid` failing | Check unique-reference/token storage |
| Token refresh not working | `DoRefreshToken` timing wrong | Verify RefreshTokenExpires (seconds × 1000) |
| Async polling timeout | status-entry-id not logged | Call LogRequestEntryID after extraction |

## Integration Points

This skill complements:
- `swagger-api-reader` - Understanding Swagger schemas
- `bank-communication-operations` - Export/Import codeunit patterns
- `bank-system-setup-wizard` - Bank system configuration
