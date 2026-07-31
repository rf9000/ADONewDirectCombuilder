# Authentication Code Patterns

Complete implementation patterns for different bank authentication types.

## Table of Contents

- [Pattern 1: SFTP Agreement-Based (AccessPay Style)](#pattern-1-sftp-agreement-based-accesspay-style)
  - [Characteristics](#characteristics)
  - [Interface Implementation](#interface-implementation)
  - [EstablishConnection Implementation](#establishconnection-implementation)
  - [GetStatus Implementation](#getstatus-implementation)
  - [RefreshConnection (Empty)](#refreshconnection-empty-for-agreement-based)
  - [IsAuthenticationEntryDetailsValid](#isauthenticationentrydetailsvalid)
  - [Request Header Building](#request-header-building)
  - [Authentication Storage](#authentication-storage)
- [Pattern 2: OAuth with Refresh Tokens (Rabobank Style)](#pattern-2-oauth-with-refresh-tokens-rabobank-style)
  - [Characteristics](#characteristics-1)
  - [Interface Implementation](#interface-implementation-1)
  - [EstablishConnection with Async Polling](#establishconnection-with-async-polling)
  - [RefreshConnection Implementation](#refreshconnection-implementation)
  - [GetToken Implementation](#gettoken-implementation)
  - [Token Storage with Expiration](#token-storage-with-expiration)
- [Pattern 3: Simple Wrapper (Yapily Style)](#pattern-3-simple-wrapper-yapily-style)
  - [Characteristics](#characteristics-2)
  - [Complete Implementation](#complete-implementation)
- [Common Helper Procedures](#common-helper-procedures)

## Pattern 1: SFTP Agreement-Based (AccessPay Style)

Used when the bank uses agreement/contract-based authentication without OAuth tokens.

### Characteristics
- No token expiration or refresh
- Agreement created once, status checked periodically
- Stores `unique-reference` UUID for identification
- Synchronous API calls (no status-entry-id polling for auth)

### Interface Implementation

```al
codeunit 71553XXX "CTS-CB {BankName} Auth" implements "CTS-CB ICommunicationType Auth", "CTS-CB IIsAuthenticationValid"
{
    Access = Internal;
```

### EstablishConnection Implementation

```al
procedure EstablishConnection(Bank: Record "CTS-CB Bank"; BankSystemCode: Code[30];
    RequestValues: Dictionary of [Text, Text]; IHttpFactory: Interface "CTS-CB IHttpFactory"): Boolean
var
    HttpRequestMessageType: HttpRequestMessage;
    ResponseJson: JsonToken;
    TracingID: Text[50];
begin
    TracingID := IHttpFactory.GetTracingIDLog().GetTracingID();

    // Build request with bank accounts
    IHttpFactory.GetBuildRequestFactory().SetHttpRequestMessageContent(
        HttpRequestMessageType,
        RequestHeader(Bank, IHttpFactory, BankSystemCode, TracingID, RequestValues,
            Enum::"CTS-CB Transaction Type"::Authentication));

    // Set URL to create agreement endpoint
    IHttpFactory.GetBuildRequestFactory().SetHttpRequestMessageURL(
        HttpRequestMessageType,
        StrSubstNo(IHttpFactory.GetUrlInterface().GetUrl('BCCreateAgreement'),
            IHttpFactory.GetCommunicationTypeUrlValue(
                GetCommunicationType(BankSystemCode)).GetUrlValue(BankSystemCode)));

    // Execute POST
    IHttpFactory.GetHttp().Post(HttpRequestMessageType, true, IHttpFactory,
        Enum::"CTS-CB Transaction Type"::Authentication);

    // Log tracing
    IHttpFactory.GetTracingIDLog().LogTracingIDNewInSession(
        CopyStr(HttpRequestMessageType.GetRequestUri(), 1, 1024), TracingID);

    // Handle response
    if HandleResponse(IHttpFactory, Bank, BankSystemCode, ResponseJson) then
        exit(HandleStatusResponse(IHttpFactory, Bank, BankSystemCode, ResponseJson));
end;
```

### GetStatus Implementation

```al
procedure GetStatus(BankAccount: Record "Bank Account"; BankSystemCode: Code[30];
    IHttpFactory: Interface "CTS-CB IHttpFactory") BankAccountStatus: Enum "CTS-CB Bank Account Status"
begin
    if IHttpFactory.GetAuthenticationFactory().GetAuthenticationSetup().AuthenticationEntryIsValid(
        BankAccount."CTS-CB Bank Code", BankSystemCode, IHttpFactory.GetAuthenticationFactory()) then
        exit(GetAgreementStatus(IHttpFactory, GetBank(BankAccount), BankSystemCode));
end;

procedure GetAgreementStatus(IHttpFactory: Interface "CTS-CB IHttpFactory";
    Bank: Record "CTS-CB Bank"; BankSystemCode: Code[30]): Enum "CTS-CB Bank Account Status"
var
    RequestValues: Dictionary of [Text, Text];
    HttpRequestMessageType: HttpRequestMessage;
    ResponseJson: JsonToken;
    TracingID: Text[50];
begin
    TracingID := IHttpFactory.GetTracingIDLog().GetTracingID();

    IHttpFactory.GetBuildRequestFactory().SetHttpRequestMessageContent(
        HttpRequestMessageType,
        RequestHeaderAgreementStatus(Bank, RequestValues, BankSystemCode, TracingID, IHttpFactory,
            Enum::"CTS-CB Transaction Type"::" "));

    IHttpFactory.GetBuildRequestFactory().SetHttpRequestMessageURL(
        HttpRequestMessageType,
        StrSubstNo(IHttpFactory.GetUrlInterface().GetUrl('BCAgreementStatus'),
            IHttpFactory.GetCommunicationTypeUrlValue(
                GetCommunicationType(BankSystemCode)).GetUrlValue(BankSystemCode)));

    IHttpFactory.GetHttp().PostUtility(HttpRequestMessageType, true, IHttpFactory);

    IHttpFactory.GetTracingIDLog().LogTracingIDNewInSession(
        CopyStr(HttpRequestMessageType.GetRequestUri(), 1, 1024), TracingID);

    HandleGetAgreementStatusResponse(IHttpFactory, Bank, BankSystemCode, ResponseJson);
    exit(IsAgreementActive(ResponseJson));
end;

procedure IsAgreementActive(Json: JsonToken) Status: Enum "CTS-CB Bank Account Status"
var
    JsonObject: JsonObject;
    StatusTok: Label 'status', Locked = true;
begin
    JsonObject := Json.AsObject();
    if not Evaluate(Status, JsonObject.GetText(StatusTok)) then
        exit(Status::NotReady);
end;
```

### RefreshConnection (Empty for Agreement-based)

```al
procedure RefreshConnection(Bank: Record "CTS-CB Bank"; BankSystemCode: Code[30];
    IHttpFactory: Interface "CTS-CB IHttpFactory")
begin
    // No refresh needed for agreement-based auth
end;
```

### IsAuthenticationEntryDetailsValid

```al
procedure IsAuthenticationEntryDetailsValid(AuthenticationEntry: Record "CTS-CB Authentication Entry";
    Value: Text; BankSystemCode: Code[30]): Boolean
begin
    // Agreement is valid if unique reference key exists
    exit(AuthenticationEntry."Unique Reference Key" <> '');
end;
```

### Request Header Building

```al
procedure RequestHeader(Bank: Record "CTS-CB Bank"; IHttpFactory: Interface "CTS-CB IHttpFactory";
    BankSystemCode: Code[30]; TracingID: Text[50]; NonPersistedValues: Dictionary of [Text, Text];
    TransactionType: Enum "CTS-CB Transaction Type") Result: Text
var
    RequestHeaderMapping: Record "CTS-CB Request Header Mapping";
    BuildRequest: Codeunit "CTS-CB Build Request";
    BankAccountInfoArray: JsonArray;
    Json: JsonObject;
    JsonArrayTxt: Text;
begin
    GetRequestHeaderMapping(RequestHeaderMapping, BankSystemCode);
    Populate(RequestHeaderMapping, Bank, NonPersistedValues, Bank.RecordId().TableNo());

    // Extract accounts array from request values
    NonPersistedValues.Get('BankName-accounts', JsonArrayTxt);
    NonPersistedValues.Remove('BankName-accounts');
    BankAccountInfoArray.ReadFrom(JsonArrayTxt);
    Json.Add('accounts', BankAccountInfoArray);

    BuildRequest.CreateRootValues(Json, NonPersistedValues, TracingID,
        IHttpFactory.GetBuildRequestFactory());

    Json.WriteTo(Result);
end;

procedure RequestHeaderAgreementStatus(Bank: Record "CTS-CB Bank";
    NonPersistedValues: Dictionary of [Text, Text]; BankSystemCode: Code[30];
    TracingID: Text[50]; IHttpFactory: Interface "CTS-CB IHttpFactory";
    TransactionType: Enum "CTS-CB Transaction Type") Result: Text
var
    RequestHeaderMapping: Record "CTS-CB Request Header Mapping";
    BuildRequest: Codeunit "CTS-CB Build Request";
    HeaderValue: Dictionary of [Text, Text];
    Json: JsonObject;
begin
    GetRequestHeaderMapping(RequestHeaderMapping, BankSystemCode);
    Populate(RequestHeaderMapping, Bank, NonPersistedValues, Bank.RecordId().TableNo());

    BuildRequest.CreateAuthentication(Json, BankSystemCode, Bank, IHttpFactory,
        HeaderValue, NonPersistedValues, TransactionType);
    BuildRequest.CreateRootValues(Json, NonPersistedValues, TracingID,
        IHttpFactory.GetBuildRequestFactory());

    Json.WriteTo(Result);
end;
```

### Authentication Storage

```al
procedure InsertAuthentication(IAuthenticationFactory: Interface "CTS-CB IAuthentication Factory";
    Bank: Record "CTS-CB Bank"; BankSystemCode: Code[30];
    IHttpFactory: Interface "CTS-CB IHttpFactory"; ResponseJsonObject: JsonObject;
    FileNameLbl: Text[100])
var
    TokenTxt: Text;
begin
    if not IAuthenticationFactory.GetAuthenticationSetup().AuthenticationEntryExists(
        Bank.Code, BankSystemCode) then begin
        GetTokenValues(TokenTxt, ResponseJsonObject);
        IAuthenticationFactory.GetAuthenticationSetup().SetAuthentication(
            Bank.Code, BankSystemCode, TokenTxt,
            0, 0, 0DT,  // No expiration for agreements
            CopyStr(CompanyName(), 1, 30), '', '',
            IHttpFactory.GetAuthenticationFactory());
    end;
end;

procedure GetTokenValues(var TokenTxt: Text; ResponseJsonObject: JsonObject)
var
    Token: JsonToken;
begin
    ResponseJsonObject.Get('authentication-items', Token);
    JsonFunctions.GetTokenAsText(Token, TokenTxt);
end;
```

---

## Pattern 2: OAuth with Refresh Tokens (Rabobank Style)

Used when the bank uses OAuth 2.0 with access and refresh tokens.

### Characteristics
- Token expiration tracking
- Automatic refresh before expiry
- Async API pattern (status-entry-id polling)
- Stores access token, refresh token, expiration times

### Interface Implementation

```al
codeunit 71553XXX "CTS-CB {BankName} Auth" implements "CTS-CB ICommunicationTypeAuthGetToken", "CTS-CB IResponseAuthHandling"
{
    Access = Internal;
```

### EstablishConnection with Async Polling

```al
procedure EstablishConnection(Bank: Record "CTS-CB Bank"; BankSystemCode: Code[30];
    RequestValues: Dictionary of [Text, Text]; IHttpFactory: Interface "CTS-CB IHttpFactory"): Boolean
var
    HttpRequestMessageType: HttpRequestMessage;
    RequestEntryID: Text[50];
    TracingID: Text[50];
begin
    SetCommunicationTypeAuth(IHttpFactory);
    TracingID := IHttpFactory.GetTracingIDLog().GetTracingID();

    // Process any pending async status entries first
    GetResponseFromOldAsyncStatusEntries(IHttpFactory, Bank, BankSystemCode,
        Enum::"CTS-CB Transaction Type"::TokenStatusEntry, '', '');
    GetResponseFromOldAsyncStatusEntries(IHttpFactory, Bank, BankSystemCode,
        Enum::"CTS-CB Transaction Type"::Authentication, '', '');

    // Check if already authenticated
    if IHttpFactory.GetAuthenticationFactory().GetAuthenticationSetup().AuthenticationEntryExists(
        Bank.Code, '') then
        exit;

    // Build and send auth request
    IHttpFactory.GetBuildRequestFactory().SetHttpRequestMessageContent(
        HttpRequestMessageType,
        RequestHeader(Bank, IHttpFactory, BankSystemCode, TracingID, RequestValues,
            Enum::"CTS-CB Transaction Type"::Authentication));

    IHttpFactory.GetBuildRequestFactory().SetHttpRequestMessageURL(
        HttpRequestMessageType,
        StrSubstNo(IHttpFactory.GetUrlInterface().GetUrl('GetAuthCode'),
            IHttpFactory.GetCommunicationTypeUrlValue(
                GetBankSystem(BankSystemCode)."Communication Type").GetUrlValue(BankSystemCode)));

    IHttpFactory.GetHttp().Post(HttpRequestMessageType, true, IHttpFactory,
        Enum::"CTS-CB Transaction Type"::Authentication);

    IHttpFactory.GetTracingIDLog().LogTracingIDNewInSession(
        CopyStr(HttpRequestMessageType.GetRequestUri(), 1, 1024), TracingID);

    // Handle async response
    if HandleResponse(IHttpFactory.GetAuthenticationFactory(), Bank, BankSystemCode,
        IHttpFactory, RequestEntryID) then begin
        // Poll for actual response
        IHttpFactory.GetRequestEntryIDLog().GetAsyncRequestEntryResponse(
            IHttpFactory, BankSystemCode, RequestEntryID);
        exit(HandleStatusResponse(IHttpFactory.GetAuthenticationFactory(), Bank,
            BankSystemCode, IHttpFactory, RequestEntryID));
    end;
end;
```

### RefreshConnection Implementation

```al
procedure RefreshConnection(Bank: Record "CTS-CB Bank"; BankSystemCode: Code[30];
    IHttpFactory: Interface "CTS-CB IHttpFactory")
var
    NonPersistedValues: Dictionary of [Text, Text];
    HttpRequestMessageType: HttpRequestMessage;
    RequestEntryID: Text[50];
    TracingID: Text[50];
begin
    // Check if refresh is needed
    if not DoRefreshToken(IHttpFactory, Bank.Code, BankSystemCode) then
        exit;

    SetCommunicationTypeAuth(IHttpFactory);
    TracingID := IHttpFactory.GetTracingIDLog().GetTracingID();

    IHttpFactory.GetBuildRequestFactory().SetHttpRequestMessageContent(
        HttpRequestMessageType,
        RefreshTokenRequestHeader(Bank, IHttpFactory, BankSystemCode, TracingID,
            NonPersistedValues, Enum::"CTS-CB Transaction Type"::RefreshConnection));

    IHttpFactory.GetBuildRequestFactory().SetHttpRequestMessageURL(
        HttpRequestMessageType,
        StrSubstNo(IHttpFactory.GetUrlInterface().GetUrl('RefreshToken'),
            IHttpFactory.GetCommunicationTypeUrlValue(
                GetCommunicationType(BankSystemCode)).GetUrlValue(BankSystemCode)));

    IHttpFactory.GetHttp().Post(HttpRequestMessageType, true, IHttpFactory,
        Enum::"CTS-CB Transaction Type"::RefreshConnection);

    IHttpFactory.GetTracingIDLog().LogTracingIDNewInSession(
        CopyStr(HttpRequestMessageType.GetRequestUri(), 1, 1024), TracingID);

    if HandleResponse(IHttpFactory.GetAuthenticationFactory(), Bank, BankSystemCode,
        IHttpFactory, RequestEntryID) then begin
        IHttpFactory.GetRequestEntryIDLog().GetAsyncRequestEntryResponse(
            IHttpFactory, BankSystemCode, RequestEntryID);
        RefreshConnectionStatusResponse(IHttpFactory.GetAuthenticationFactory(), Bank,
            BankSystemCode, IHttpFactory);
    end;
end;

procedure DoRefreshToken(IHttpFactory: Interface "CTS-CB IHttpFactory";
    BankCode: Code[30]; BankSystemCode: Code[30]): Boolean
var
    LastUpdated: DateTime;
    TokenExpirationDate: DateTime;
    AccessTokenExpires: Duration;
    RefreshTokenExpires: Duration;
begin
    IHttpFactory.GetAuthenticationFactory().GetAuthenticationSetup().GetExpirationValues(
        BankCode, BankSystemCode, IHttpFactory.GetAuthenticationFactory(),
        AccessTokenExpires, RefreshTokenExpires, TokenExpirationDate, LastUpdated);

    exit(GetRefreshTokenCutOff(AccessTokenExpires, LastUpdated));
end;

procedure GetRefreshTokenCutOff(TokenExpirationDate: Duration; LastUpdated: DateTime): Boolean
var
    DurationSinceLastCheck: Duration;
    TimeBetweenChecks: Duration;
begin
    // Refresh when 1/3 of token lifetime has passed
    TimeBetweenChecks := Round(TokenExpirationDate / 3, 1, '=');
    DurationSinceLastCheck := Round((CurrentDateTime() - LastUpdated) / 1000, 1, '=');
    exit(DurationSinceLastCheck > TimeBetweenChecks);
end;
```

### GetToken Implementation

```al
procedure GetToken(IHttpFactory: Interface "CTS-CB IHttpFactory"; Bank: Record "CTS-CB Bank";
    BankSystemCode: Code[30]): Boolean
var
    RequestValues: Dictionary of [Text, Text];
    HttpRequestMessageType: HttpRequestMessage;
    RequestEntryID: Text[50];
    TracingID: Text[50];
begin
    TracingID := IHttpFactory.GetTracingIDLog().GetTracingID();

    if IHttpFactory.GetAuthenticationFactory().GetAuthenticationSetup().AuthenticationEntryIsValid(
        Bank.Code, BankSystemCode, IHttpFactory.GetAuthenticationFactory()) then
        exit;

    IHttpFactory.GetBuildRequestFactory().SetHttpRequestMessageContent(
        HttpRequestMessageType,
        RequestHeader(Bank, IHttpFactory, BankSystemCode, TracingID, RequestValues,
            Enum::"CTS-CB Transaction Type"::Authentication));

    IHttpFactory.GetBuildRequestFactory().SetHttpRequestMessageURL(
        HttpRequestMessageType,
        StrSubstNo(IHttpFactory.GetUrlInterface().GetUrl('GetToken'),
            IHttpFactory.GetCommunicationTypeUrlValue(
                GetBankSystem(BankSystemCode)."Communication Type").GetUrlValue(BankSystemCode)));

    IHttpFactory.GetHttp().Post(HttpRequestMessageType, true, IHttpFactory,
        Enum::"CTS-CB Transaction Type"::Authentication);

    IHttpFactory.GetTracingIDLog().LogTracingIDNewInSession(
        CopyStr(HttpRequestMessageType.GetRequestUri(), 1, 1024), TracingID);

    exit(HandleGetTokenStatusResponse(IHttpFactory.GetAuthenticationFactory(), Bank,
        BankSystemCode, IHttpFactory, RequestEntryID));
end;
```

### Token Storage with Expiration

```al
procedure InsertAuthentication(IAuthenticationFactory: Interface "CTS-CB IAuthentication Factory";
    Bank: Record "CTS-CB Bank"; BankSystemCode: Code[30];
    IHttpFactory: Interface "CTS-CB IHttpFactory"; ResponseJsonObject: JsonObject;
    FileNameLbl: Text[100])
var
    AccessTokenExpiresIn: Duration;
    RefreshTokenExpiresIn: Duration;
    TokenTxt: Text;
begin
    if not IAuthenticationFactory.GetAuthenticationSetup().AuthenticationEntryExists(
        Bank.Code, BankSystemCode) then begin
        GetTokenValues(Bank, TokenTxt, AccessTokenExpiresIn, RefreshTokenExpiresIn,
            ResponseJsonObject, IHttpFactory, BankSystemCode);
        IAuthenticationFactory.GetAuthenticationSetup().SetAuthentication(
            Bank.Code, BankSystemCode, TokenTxt,
            AccessTokenExpiresIn, RefreshTokenExpiresIn, 0DT,
            CopyStr(CompanyName(), 1, 30), '', '',
            IHttpFactory.GetAuthenticationFactory());
    end else begin
        GetTokenValues(Bank, TokenTxt, AccessTokenExpiresIn, RefreshTokenExpiresIn,
            ResponseJsonObject, IHttpFactory, BankSystemCode);
        IAuthenticationFactory.GetAuthenticationSetup().Update(
            Bank.Code, BankSystemCode, TokenTxt,
            AccessTokenExpiresIn, RefreshTokenExpiresIn, 0DT, '', '',
            IHttpFactory.GetAuthenticationFactory());
    end;
    Commit(); // Critical: save token immediately
end;

procedure GetTokenValues(var Bank: Record "CTS-CB Bank"; var TokenTxt: Text;
    var AccessTokenExpiresIn: Duration; var RefreshTokenExpiresIn: Duration;
    ResponseJsonObject: JsonObject; IHttpFactory: Interface "CTS-CB IHttpFactory";
    BankSystemCode: Code[30])
var
    AuthenticationItemObject: JsonObject;
    AuthenticationItemToken: JsonToken;
    StatusEntryIDForAccessToken: JsonToken;
    UrlToken: JsonToken;
    UrlTxt: Text;
    RequestEntryID: Text[50];
begin
    // Extract signup URL if present
    if ResponseJsonObject.Get('url', UrlToken) then begin
        JsonFunctions.GetTokenAsText(UrlToken, UrlTxt);
        Bank."Signup Link" := CopyStr(UrlTxt, 1, MaxStrLen(Bank."Signup Link"));
        Bank.Modify();
    end;

    // Extract authentication items
    if ResponseJsonObject.Get('authentication-items', AuthenticationItemToken) then begin
        AuthenticationItemObject := AuthenticationItemToken.AsObject();
        TokenTxt := Format(AuthenticationItemObject);
        AccessTokenExpiresIn := ExtractTokenExpiration(AuthenticationItemObject, 'expires-in');
        RefreshTokenExpiresIn := ExtractTokenExpiration(AuthenticationItemObject, 'refresh-token-expires-in');
    end;

    // Log status entry ID for token tracking
    if ResponseJsonObject.Get('status-entry-id', StatusEntryIDForAccessToken) then
        RequestEntryID := CopyStr(StatusEntryIDForAccessToken.AsValue().AsText(), 1, MaxStrLen(RequestEntryID));
    IHttpFactory.GetRequestEntryIDLog().LogRequestEntryID(
        RequestEntryID, BankSystemCode, '', Enum::"CTS-CB File Type"::" ",
        Enum::"CTS-CB Transaction Type"::TokenStatusEntry, '', '');
end;

procedure ExtractTokenExpiration(ResponseJsonObject: JsonObject; TokenName: Text): Duration
var
    ExpirationSeconds: Integer;
    TokenObj: JsonToken;
begin
    if not ResponseJsonObject.Get(TokenName, TokenObj) then
        exit(0);
    ExpirationSeconds := TokenObj.AsValue().AsInteger();
    exit(ExpirationSeconds * 1000); // Convert seconds to milliseconds
end;
```

---

## Pattern 3: Simple Wrapper (Yapily Style)

Used when OAuth flow is handled externally and the codeunit just provides interface compliance.

### Characteristics
- Minimal implementation
- Authentication handled by external flow (user authorization page)
- Just stores/retrieves auth tokens
- No active refresh logic in codeunit

### Complete Implementation

```al
codeunit 71553XXX "CTS-CB {BankName} Auth" implements "CTS-CB ICommunicationType Auth"
{
    Access = Internal;

    procedure EstablishConnection(Bank: Record "CTS-CB Bank"; BankSystemCode: Code[30];
        RequestValues: Dictionary of [Text, Text]; IHttpFactory: Interface "CTS-CB IHttpFactory"): Boolean
    begin
        SetCommunicationTypeAuth(IHttpFactory);
        // External OAuth flow handles actual authentication
    end;

    procedure GetStatus(BankAccount: Record "Bank Account"; BankSystemCode: Code[30];
        IHttpFactory: Interface "CTS-CB IHttpFactory"): Enum "CTS-CB Bank Account Status"
    begin
        // Status determined by external checks or stored auth validity
    end;

    procedure RefreshConnection(Bank: Record "CTS-CB Bank"; BankSystemCode: Code[30];
        IHttpFactory: Interface "CTS-CB IHttpFactory")
    begin
        // Refresh handled by external flow
    end;

    procedure GetAuthenticationItem(Bank: Record "CTS-CB Bank";
        IAuthenticationFactory: Interface "CTS-CB IAuthentication Factory";
        BankSystemCode: Code[30]) AuthenticationItem: JsonObject
    var
        Value: Text;
    begin
        IAuthenticationFactory.GetAuthenticationSetup().GetAuthenticationEntryStorageEntry(
            Bank.Code, BankSystemCode, Value, IAuthenticationFactory);
        AuthenticationItem.ReadFrom(Value);
        exit(AuthenticationItem);
    end;

    procedure SetCommunicationTypeAuth(IHttpFactory: Interface "CTS-CB IHttpFactory")
    var
        ThisAuth: Codeunit "CTS-CB {BankName} Auth";
    begin
        IHttpFactory.SetICommunicationTypeAuth(ThisAuth);
    end;
}
```

---

## Common Helper Procedures

These procedures are shared across most authentication patterns:

```al
procedure GetBank(BankAccount: Record "Bank Account") Bank: Record "CTS-CB Bank"
begin
    Bank.Get(BankAccount."CTS-CB Bank Code");
end;

procedure GetBank(BankCode: Code[30]) Bank: Record "CTS-CB Bank"
begin
    if Bank.Get(BankCode) then;
end;

local procedure GetBankSystem(BankSystemCode: Code[30]) BankSystem: Record "CTS-CB Bank System"
begin
    BankSystem.SetLoadFields("Communication Type");
    BankSystem.Get(BankSystemCode);
end;

local procedure GetCommunicationType(BankSystemCode: Code[30]): Enum "CTS-CB Communication Type"
var
    GetCommTypeBankSystem: Codeunit "CTS-CB GetCommTypeBankSystem";
begin
    exit(GetCommTypeBankSystem.GetCommunicationType(BankSystemCode));
end;

procedure Populate(var RequestHeaderMapping: Record "CTS-CB Request Header Mapping";
    ValueVariant: Variant; var HeaderValues: Dictionary of [Text, Text]; TableNo: Integer)
var
    PopulateRequestHeader: Codeunit "CTS-CB Populate Request Header";
begin
    PopulateRequestHeader.GetValuesFromTable(RequestHeaderMapping, ValueVariant, HeaderValues, TableNo);
end;

procedure GetRequestHeaderMapping(var RequestHeaderMapping: Record "CTS-CB Request Header Mapping";
    BankSystemCodeDirect: Code[30])
begin
    RequestHeaderMapping.SetRange("Bank System Code", BankSystemCodeDirect);
end;
```
