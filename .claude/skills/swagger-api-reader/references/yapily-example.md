# Yapily API Reference Example

This file documents the Yapily Swagger API as a reference implementation for all Continia Banking APIs.

## Endpoint Summary

| Endpoint | Method | Type | Request Schema | Response |
|----------|--------|------|----------------|----------|
| `/conversion` | POST | Sync | PayloadConversionRequest | PayloadConversionResponse |
| `/gettoken` | POST | Async | YapilyGetTokenRequest | StatusEntryIdResponse |
| `/extendconsent` | POST | Async | YapilyExtendConsentRequest | StatusEntryIdResponse |
| `/send` | POST | Async | YapilySendRequest | StatusEntryIdResponse |
| `/gettransactions` | POST | Async | YapilyGetTransactionsRequest | StatusEntryIdResponse |
| `/getaccounts` | POST | Async | YapilyGetAccountsRequest | StatusEntryIdResponse |
| `/getpaymentstatus` | POST | Async | YapilyGetPaymentStatusRequest | StatusEntryIdResponse |
| `/gettokencallback` | GET | Callback | - | (External use only) |
| `/status` | POST | Poll | StatusRequest | YapilyResponsePayload |
| `/deletestatus` | POST | Cleanup | StatusRequest | (empty 200) |

## Response Payload Structure

### YapilyResponsePayload

The `/status` endpoint returns this structure containing the actual response data:

```json
{
  "status": "Completed",  // enum: Unknown, Requested, Pending, InProgress, Completed, Failed
  "content": { /* varies based on original endpoint */ }
}
```

### Content Type Mapping

| Original Endpoint | Content Type |
|-------------------|--------------|
| /gettoken | YapilyGetTokenResponse |
| /extendconsent | YapilyExtendConsentResponse |
| /gettransactions | YapilyTransactionsResponse |
| /getaccounts | YapilyAccountsResponse |
| /send | (embedded in authentication flow) |

## Request Schemas

### Common Base Fields

All async requests share these fields:

```json
{
  "transaction-id": "uuid",      // Required - unique transaction identifier
  "company-guid": "uuid",        // Required - BC company ID
  "bc-user-name": "string",      // Required - BC user name
  "compression": true/false      // Optional - compress payload content
}
```

### StatusRequest (for /status and /deletestatus)

```json
{
  "status-entry-id": "3fa85f64-5717-4562-b3fc-2c963f66afa6",
  "transaction-id": "uuid",
  "company-guid": "uuid",
  "bc-user-name": "string"
}
```

### YapilyAuthentication Object

Used in requests requiring bank authentication:

```json
{
  "authentication": {
    "institution": "bank-code",
    "application-user-id": "user-id",
    "authentication-items": {
      "token": "consent-token-from-gettoken"
    }
  }
}
```

### YapilyGetTokenRequest

Initiates OAuth consent flow:

```json
{
  "payload": {
    "content": "base64-encoded-payment-data or null"
  },
  "transaction-id": "uuid",
  "company-guid": "uuid",
  "bc-user-name": "string",
  "compression": false,
  "user": "application-user-id",
  "institution": "bank-code",
  "token-type": "ACCOUNT|BULKPAYMENT|SINGLEPAYMENT",
  "originator-identification-number": "optional",
  "psu-ip-address": "optional",
  "psu-corporate-id": "optional",
  "psu-id": "optional",
  "legal-entity": {
    "full-name": "string",
    "legal-form": "string",
    "company-name": "string",
    "extended-validation-required": false,
    "is-validated": false,
    "addresses": [
      {
        "street-name": "string",
        "zip-code": "string",
        "city": "string",
        "country": "string",
        "address-type": "RegisteredOfficeAddress|OperatingAddress|ResidentalAddress"
      }
    ]
  }
}
```

### YapilySendRequest

Sends payments to bank:

```json
{
  "payload": {
    "content": "base64-encoded or array of PaymentRequest"
  },
  "authentication": { /* YapilyAuthentication */ },
  "transaction-id": "uuid",
  "company-guid": "uuid",
  "bc-user-name": "string",
  "compression": false,
  "user": "optional",
  "token-type": "ACCOUNT|BULKPAYMENT|SINGLEPAYMENT",
  "originator-identification-number": "optional",
  "psu-ip-address": "optional",
  "psu-corporate-id": "optional",
  "psu-id": "optional"
}
```

### YapilyGetTransactionsRequest

Fetches bank transactions:

```json
{
  "authentication": { /* YapilyAuthentication */ },
  "transaction-id": "uuid",
  "company-guid": "uuid",
  "bc-user-name": "string",
  "compression": false,
  "iban": "optional - filter by IBAN",
  "sort-code": "optional",
  "account-id": "optional - bank account ID",
  "account-number": "optional",
  "bic-swift": "optional",
  "from": "date string - start date",
  "to": "date string - end date",
  "offset": "pagination offset",
  "psu-ip-address": "optional",
  "psu-corporate-id": "optional",
  "psu-id": "optional"
}
```

### YapilyGetAccountsRequest

Fetches bank accounts:

```json
{
  "authentication": { /* YapilyAuthentication */ },
  "transaction-id": "uuid",
  "company-guid": "uuid",
  "bc-user-name": "string",
  "compression": false,
  "psu-ip-address": "optional",
  "psu-corporate-id": "optional",
  "psu-id": "optional"
}
```

### YapilyGetPaymentStatusRequest

Checks payment execution status at the bank:

```json
{
  "authentication": { /* YapilyAuthentication */ },
  "transaction-id": "uuid",
  "company-guid": "uuid",
  "bc-user-name": "string",
  "compression": false,
  "token-type": "ACCOUNT|BULKPAYMENT|SINGLEPAYMENT",
  "payment-id": "bank-payment-id",
  "psu-ip-address": "optional",
  "psu-corporate-id": "optional",
  "psu-id": "optional"
}
```

### YapilyExtendConsentRequest

Extends existing consent:

```json
{
  "consent-id": "uuid - existing consent",
  "last-confirmed-at": "datetime",
  "transaction-id": "uuid",
  "company-guid": "uuid",
  "bc-user-name": "string"
}
```

## Response Schemas

### YapilyGetTokenResponse

```json
{
  "tracing-id": "string",
  "consent-id": "uuid",
  "status-entry-id": "uuid",
  "url": "https://bank.com/authorize?..."  // User redirects here for consent
}
```

### YapilyExtendConsentResponse

```json
{
  "tracing-id": "string",
  "consent-id": "uuid"
}
```

### YapilyTransactionsResponse

```json
{
  "tracing-id": "string",
  "offset": "pagination-token",
  "payload": {
    "content": "base64-encoded transaction data or array"
  }
}
```

### YapilyAccountsResponse

```json
{
  "tracing-id": "string",
  "payload": {
    "content": "base64-encoded account data or array"
  }
}
```

## Payment Request Structure

Used in /send and /gettoken payloads:

### PaymentRequest

```json
{
  "paymentIdempotencyId": "unique-payment-id",  // Required
  "type": "DOMESTIC_PAYMENT",                    // Required - see enum below
  "amount": {                                    // Required
    "amount": 100.50,
    "currency": "EUR"
  },
  "payee": {                                     // Required
    "name": "Recipient Name",
    "accountIdentifications": [
      {
        "type": "IBAN",
        "identification": "DE89370400440532013000"
      }
    ],
    "address": { /* optional Address */ }
  },
  "payer": {                                     // Optional
    "name": "Payer Name",
    "accountIdentifications": [
      {
        "type": "IBAN",
        "identification": "NL91ABNA0417164300"
      }
    ]
  },
  "reference": "Payment reference",              // Optional
  "contextType": "BILL",                         // Optional
  "purposeCode": "SALA",                         // Optional
  "paymentDateTime": "2024-01-15T10:00:00Z",    // Optional - for scheduled
  "periodicPayment": { /* for recurring */ },    // Optional
  "internationalPayment": { /* for intl */ },    // Optional
  "readRefundAccount": false                     // Optional
}
```

### Payment Type Enum

```
DOMESTIC_PAYMENT
DOMESTIC_INSTANT_PAYMENT
DOMESTIC_VARIABLE_RECURRING_PAYMENT
DOMESTIC_SCHEDULED_PAYMENT
DOMESTIC_PERIODIC_PAYMENT
INTERNATIONAL_PAYMENT
INTERNATIONAL_SCHEDULED_PAYMENT
INTERNATIONAL_PERIODIC_PAYMENT
BULK_PAYMENT
```

### Account Identification Type Enum

```
SORT_CODE, ACCOUNT_NUMBER, IBAN, BBAN, BIC, PAN, MASKED_PAN,
MSISDN, BSB, NCC, ABA, ABA_WIRE, ABA_ACH, EMAIL, ROLL_NUMBER,
BLZ, IFS, CLABE, CTN, BRANCH_CODE, VIRTUAL_ACCOUNT_ID
```

### Context Type Enum

```
BILL, GOODS, SERVICES, OTHER, PERSON_TO_PERSON,
BILL_IN_ADVANCE, BILL_IN_ARREARS, ECOMMERCE_MERCHANT,
FACE_TO_FACE_POS, TRANSFER_TO_SELF, TRANSFER_TO_THIRD_PARTY,
PISP_PAYEE
```

## Conversion Endpoint (Synchronous)

### PayloadConversionRequest

```json
{
  "payload": {
    "content": "base64-encoded-file-content"
  },
  "file-type": "CAMT053",  // see enum below
  "transaction-id": "uuid",
  "company-guid": "uuid",
  "bc-user-name": "string",
  "compression": false
}
```

### File Type Enum

```
CAMT052          - Intraday report
CAMT053          - End-of-day statement
CAMT054          - Debit/credit notification
CAMT055          - Customer payment cancellation
PAIN001          - Credit transfer initiation
PAIN002          - Payment status report
PAIN008          - Direct debit initiation
MT940            - SWIFT statement
CAMT053E         - Extended CAMT053
CAMT054C         - CAMT054 variant C
PBSSEKTOR        - PBS sector format (Denmark)
CAMT054D         - CAMT054 variant D
SEPA             - SEPA format
CUSTOMSTATUS     - Custom status format
CUSTOMPAYMENT    - Custom payment format
CUSTOMSTATEMENT  - Custom statement format
CUSTOMDEBITCREDITNOTIFICATION - Custom notification
CUSTOMDIRECTDEBIT - Custom direct debit
STANDARD18       - Standard 18 format
```

### PayloadConversionResponse

```json
{
  "payload": {
    "content": "base64-encoded-converted-content"
  },
  "file-type": "PAIN001"  // output format
}
```

## Error Responses

### ValidationProblemDetails (HTTP 400)

```json
{
  "type": "https://tools.ietf.org/html/rfc7231#section-6.5.1",
  "title": "One or more validation errors occurred.",
  "status": 400,
  "detail": "See errors for details",
  "instance": "/public-api/v1/yapily/send",
  "errors": {
    "transaction-id": ["The transaction-id field is required."],
    "payload.content": ["Content cannot be empty."]
  }
}
```

### ApiError (HTTP 404, 415, 500)

```json
{
  "message": "Status entry not found",
  "details": "No status entry exists with ID 3fa85f64-5717-4562-b3fc-2c963f66afa6",
  "errors": []
}
```

## Token Types

```
ACCOUNT       - Account information access
BULKPAYMENT   - Bulk payment consent
SINGLEPAYMENT - Single payment consent
```

## Complete Flow Example

### 1. Get Token (OAuth Consent)

```
POST /public-api/v1/yapily/gettoken
{
  "payload": { "content": null },
  "transaction-id": "11111111-1111-1111-1111-111111111111",
  "company-guid": "22222222-2222-2222-2222-222222222222",
  "bc-user-name": "ADMIN",
  "institution": "modelo-sandbox",
  "token-type": "ACCOUNT"
}

Response: { "status-entry-id": "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa" }
```

### 2. Poll Status

```
POST /public-api/v1/yapily/status
{
  "status-entry-id": "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
  "transaction-id": "11111111-1111-1111-1111-111111111111",
  "company-guid": "22222222-2222-2222-2222-222222222222",
  "bc-user-name": "ADMIN"
}

Response (pending):
{
  "status": "Pending",
  "content": {
    "consent-id": "cccccccc-cccc-cccc-cccc-cccccccccccc",
    "url": "https://bank.com/authorize?consent=..."
  }
}

Response (after user authorizes):
{
  "status": "Completed",
  "content": {
    "tracing-id": "trace-123",
    "consent-id": "cccccccc-cccc-cccc-cccc-cccccccccccc",
    "status-entry-id": "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
    "url": null
  }
}
```

### 3. Fetch Accounts

```
POST /public-api/v1/yapily/getaccounts
{
  "authentication": {
    "institution": "modelo-sandbox",
    "application-user-id": "user-123",
    "authentication-items": {
      "token": "consent-token-from-callback"
    }
  },
  "transaction-id": "33333333-3333-3333-3333-333333333333",
  "company-guid": "22222222-2222-2222-2222-222222222222",
  "bc-user-name": "ADMIN"
}

Response: { "status-entry-id": "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb" }
```

### 4. Poll for Accounts

```
POST /public-api/v1/yapily/status
{
  "status-entry-id": "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
  ...
}

Response:
{
  "status": "Completed",
  "content": {
    "tracing-id": "trace-456",
    "payload": {
      "content": "eyJhY2NvdW50cyI6Wy4uLl19"  // base64 encoded accounts
    }
  }
}
```

### 5. Cleanup

```
POST /public-api/v1/yapily/deletestatus
{
  "status-entry-id": "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
  ...
}

Response: 200 OK (empty)
```
