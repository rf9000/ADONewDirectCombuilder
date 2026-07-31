# Swagger to AL Code Mapping

Quick reference for translating Swagger schemas to AL code. For understanding Swagger structure, use the `swagger-api-reader` skill.

## Request Field → AL Source

| Swagger Field | AL Source |
|---------------|-----------|
| `transaction-id` | `IHttpFactory.GetTracingIDLog().GetTracingID()` |
| `company-guid` | `BuildRequest.CreateRootValues()` (auto) |
| `bc-user-name` | `BuildRequest.CreateRootValues()` (auto) |
| `sun-user-name`, `sun-user-number`, etc. | `RequestHeaderMapping` → Bank table fields |
| `authentication.authentication-items` | `BuildRequest.CreateAuthentication()` |
| `accounts[]` | `RequestValues.Get('BankName-accounts', JsonArrayTxt)` |

## Response Field → AL Storage

| Swagger Field | AL Destination |
|---------------|----------------|
| `status-entry-id` | `RequestEntryIDLog.LogRequestEntryID()` |
| `authentication-items` | `AuthenticationEntry` (via `SetAuthentication`) |
| `authentication-items.unique-reference` | `AuthenticationEntry."Unique Reference Key"` |
| `authentication-items.expires-in` | `AccessTokenExpiresIn: Duration` (seconds × 1000) |
| `authentication-items.refresh-token-expires-in` | `RefreshTokenExpiresIn: Duration` |
| `url` | `Bank."Signup Link"` |
| `status` | `Enum "CTS-CB Bank Account Status"` |
| `errors[]` | `FileArchive` + `Error()` |

## URL Key Configuration

| Swagger Endpoint | URL Key |
|------------------|---------|
| `/BusinessCentral/createagreement` | `BCCreateAgreement` |
| `/BusinessCentral/agreementstatus` | `BCAgreementStatus` |
| `/gettoken` (initiate) | `GetAuthCode` |
| `/gettoken` (callback) | `GetToken` |
| `/refreshtoken` | `RefreshToken` |

## AL Code Snippets

### Extracting status-entry-id
```al
if ResponseJsonObject.Get('status-entry-id', Token) then begin
    RequestEntryID := CopyStr(Token.AsValue().AsText(), 1, 50);
    IHttpFactory.GetRequestEntryIDLog().LogRequestEntryID(
        RequestEntryID, BankSystemCode, '', Enum::"CTS-CB File Type"::" ",
        TransactionType, '', '');
end;
```

### Extracting token expiration (seconds → Duration)
```al
procedure ExtractTokenExpiration(JsonObj: JsonObject; FieldName: Text): Duration
var
    Token: JsonToken;
begin
    if not JsonObj.Get(FieldName, Token) then
        exit(0);
    exit(Token.AsValue().AsInteger() * 1000); // seconds to ms
end;
```

### Storing authentication
```al
IAuthenticationFactory.GetAuthenticationSetup().SetAuthentication(
    Bank.Code, BankSystemCode, TokenTxt,
    AccessTokenExpiresIn, RefreshTokenExpiresIn, 0DT,
    CopyStr(CompanyName(), 1, 30), '', '',
    IHttpFactory.GetAuthenticationFactory());
Commit(); // Critical: persist immediately
```

### Building URL with bank substitution
```al
IHttpFactory.GetBuildRequestFactory().SetHttpRequestMessageURL(
    HttpRequestMessage,
    StrSubstNo(IHttpFactory.GetUrlInterface().GetUrl('BCCreateAgreement'),
        IHttpFactory.GetCommunicationTypeUrlValue(
            GetCommunicationType(BankSystemCode)).GetUrlValue(BankSystemCode)));
```

## JSON Naming Convention

API uses kebab-case → AL uses string literals:
- `status-entry-id` → `'status-entry-id'`
- `authentication-items` → `'authentication-items'`
- `expires-in` → `'expires-in'`
