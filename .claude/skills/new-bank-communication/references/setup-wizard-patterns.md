# Bank Setup Wizard Patterns

Patterns for creating bank-specific assisted setup wizards. For general wizard patterns, see the `assisted-setup-wizard` skill.

## Overview

Each bank system typically has:
1. **Setup Codeunit** - Implements `IAssisted Bank Account Setup` interface
2. **Setup Page** - NavigatePage wizard for bank-specific configuration

## Architecture

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                    BANK SETUP WIZARD ARCHITECTURE                            │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  CommunicationType.Enum.al                                                  │
│  └── value(XX; NewBank)                                                     │
│      └── Implementation =                                                   │
│          "CTS-CB IAssisted Bank Account Setup" = "CTS-CB NewBank Setup"     │
│                                                                             │
│  NewBankAssistSetup.Codeunit.al (implements IAssisted Bank Account Setup)   │
│  └── SetupBankAccount()                                                     │
│      └── Opens NewBankAssistSetup.Page.al                                   │
│                                                                             │
│  NewBankAssistSetup.Page.al (NavigatePage)                                  │
│  └── Bank-specific fields (email, company name, credentials)               │
│  └── Step-based navigation (Welcome → Configure → External Auth → Finish)  │
│  └── ClosedByFinish() - returns true if user completed wizard              │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## Setup Codeunit Pattern

### Interface Implementation

```al
codeunit 71553XXX "CTS-CB {BankName} Assist Setup" implements "CTS-CB IAssisted Bank Account Setup"
{
    Access = Internal;

    procedure SetupBankAccount(var Bank: Record "CTS-CB Bank";
        var BankAccount: Record "Bank Account"; BankSystemCode: Code[30]): Boolean
    var
        {BankName}AssistSetup: Page "CTS-CB {BankName} Assist Setup";
    begin
        // Optional: Check if already pending/authenticated
        if GetStatus(BankAccount, BankSystemCode) = Status::Pending then begin
            Message(AlreadyPendingMsg);
            exit(false);
        end;

        // Configure the page
        {BankName}AssistSetup.SetGlobalBank(Bank);
        {BankName}AssistSetup.SetGlobalBankSystem(BankSystemCode);

        // Run modal and check result
        {BankName}AssistSetup.RunModal();
        exit({BankName}AssistSetup.ClosedByFinish());
    end;
}
```

### Complete Example (DNB Pattern)

```al
codeunit 71553616 "CTS-CB DNB Assist Setup" implements "CTS-CB IAssisted Bank Account Setup"
{
    Access = Internal;

    procedure SetupBankAccount(var Bank: Record "CTS-CB Bank";
        var BankAccount: Record "Bank Account"; BankSystemCode: Code[30]): Boolean
    var
        DNBAssistSetup: Page "CTS-CB DNB Assist Setup";
        IHttpFactory: Interface "CTS-CB IHttpFactory";
    begin
        // Check current status
        case GetStatus(BankAccount, BankSystemCode, IHttpFactory) of
            "CTS-CB Bank Account Status"::Pending:
                begin
                    Message(PendingApprovalMsg);
                    exit(false);
                end;
            "CTS-CB Bank Account Status"::Active:
                begin
                    Message(AlreadyActiveMsg);
                    exit(false);
                end;
        end;

        // Run setup wizard
        DNBAssistSetup.SetGlobalBank(Bank);
        DNBAssistSetup.SetGlobalBankSystem(BankSystemCode);
        DNBAssistSetup.RunModal();

        exit(DNBAssistSetup.ClosedByFinish());
    end;

    local procedure GetStatus(BankAccount: Record "Bank Account"; BankSystemCode: Code[30];
        IHttpFactory: Interface "CTS-CB IHttpFactory"): Enum "CTS-CB Bank Account Status"
    var
        CommunicationFactory: Codeunit "CTS-CB Communication Factory";
    begin
        exit(CommunicationFactory.GetCommunicationTypeAuth(BankAccount, BankSystemCode)
            .GetStatus(BankAccount, BankSystemCode, IHttpFactory));
    end;
}
```

---

## Setup Page Pattern

### Basic Structure

```al
page 71553XXX "CTS-CB {BankName} Assist Setup"
{
    Caption = '{BankName} Setup';
    PageType = NavigatePage;
    SourceTable = "CTS-CB Bank";
    SourceTableTemporary = true;

    layout
    {
        area(Content)
        {
            // Step 1: Welcome
            group(Step1)
            {
                ShowCaption = false;
                Visible = Step1Visible;

                group("Welcome Title")
                {
                    Caption = 'Welcome to {BankName} Setup', Comment = 'Wizard step Headline';
                    InstructionalText = 'This wizard will help you connect your bank account to {BankName}.';
                }
            }

            // Step 2: Configuration
            group(Step2)
            {
                ShowCaption = false;
                Visible = Step2Visible;

                group("Configuration Title")
                {
                    Caption = 'Configure {BankName} Connection', Comment = 'Wizard step Headline';

                    field(ContactEmail; GlobalContactEmail)
                    {
                        ApplicationArea = All;
                        Caption = 'Contact Email';
                        ShowMandatory = true;
                    }
                    field(CompanyName; GlobalCompanyName)
                    {
                        ApplicationArea = All;
                        Caption = 'Company Name';
                        ShowMandatory = true;
                    }
                }
            }

            // Step 3: External Authorization (if OAuth)
            group(Step3)
            {
                ShowCaption = false;
                Visible = Step3Visible;

                group("External Auth Title")
                {
                    Caption = 'Complete Authorization', Comment = 'Wizard step Headline';

                    field(ExternalUrl; ExternalUrlLbl)
                    {
                        ApplicationArea = All;
                        Caption = 'Click here to authorize';
                        Editable = false;

                        trigger OnDrillDown()
                        begin
                            Hyperlink(GlobalSignupLink);
                        end;
                    }
                }
            }

            // Step Finish
            group(StepFinish)
            {
                ShowCaption = false;
                Visible = StepFinishVisible;

                group("Finish Title")
                {
                    Caption = 'Setup Complete', Comment = 'Wizard step Headline';
                    InstructionalText = 'Your {BankName} connection has been configured successfully.';
                }
            }
        }
    }

    actions
    {
        area(Processing)
        {
            action(ActionBack)
            {
                Caption = 'Back';
                Enabled = BackActionEnabled;
                Image = PreviousRecord;
                InFooterBar = true;

                trigger OnAction()
                begin
                    NextStep(true, false);
                end;
            }
            action(ActionNext)
            {
                Caption = 'Next';
                Enabled = NextActionEnabled;
                Image = NextRecord;
                InFooterBar = true;

                trigger OnAction()
                begin
                    NextStep(false, false);
                end;
            }
            action(ActionFinish)
            {
                Caption = 'Finish';
                Enabled = FinishActionEnabled;
                Image = Approve;
                InFooterBar = true;

                trigger OnAction()
                begin
                    FinishAction();
                end;
            }
        }
    }

    var
        GlobalBank: Record "CTS-CB Bank";
        GlobalBankSystemCode: Code[30];
        GlobalContactEmail: Text[80];
        GlobalCompanyName: Text[100];
        GlobalSignupLink: Text[250];
        Step: Enum "CTS-CB {BankName} Setup Step";
        Step1Visible: Boolean;
        Step2Visible: Boolean;
        Step3Visible: Boolean;
        StepFinishVisible: Boolean;
        BackActionEnabled: Boolean;
        NextActionEnabled: Boolean;
        FinishActionEnabled: Boolean;
        Finished: Boolean;
        ExternalUrlLbl: Label 'Click here to complete authorization in your browser';

    trigger OnOpenPage()
    begin
        Step := Step::Start;
        EnableControls();
    end;

    internal procedure SetGlobalBank(Bank: Record "CTS-CB Bank")
    begin
        GlobalBank := Bank;
    end;

    internal procedure SetGlobalBankSystem(BankSystemCode: Code[30])
    begin
        GlobalBankSystemCode := BankSystemCode;
    end;

    internal procedure ClosedByFinish(): Boolean
    begin
        exit(Finished);
    end;

    local procedure FinishAction()
    begin
        // Save configuration
        SaveConfiguration();
        Finished := true;
        CurrPage.Close();
    end;

    local procedure EnableControls()
    begin
        ResetControls();
        case Step of
            Step::Start:
                ShowStep1();
            Step::Step2:
                ShowStep2();
            Step::Step3:
                ShowStep3();
            Step::Finish:
                ShowFinishStep();
        end;
    end;

    local procedure ResetControls()
    begin
        Step1Visible := false;
        Step2Visible := false;
        Step3Visible := false;
        StepFinishVisible := false;
        BackActionEnabled := true;
        NextActionEnabled := true;
        FinishActionEnabled := false;
    end;

    local procedure ShowStep1()
    begin
        Step1Visible := true;
        BackActionEnabled := false;
    end;

    local procedure ShowStep2()
    begin
        Step2Visible := true;
    end;

    local procedure ShowStep3()
    begin
        Step3Visible := true;
        // If no external auth needed, skip to finish
        if GlobalSignupLink = '' then begin
            Step := Step::Finish;
            EnableControls();
        end;
    end;

    local procedure ShowFinishStep()
    begin
        StepFinishVisible := true;
        NextActionEnabled := false;
        FinishActionEnabled := true;
    end;

    local procedure NextStep(Backwards: Boolean; SystemInvoked: Boolean)
    begin
        if not Backwards then
            ValidateSteps(SystemInvoked);

        case Step of
            Step::Start:
                Step := Step::Step2;
            Step::Step2:
                if Backwards then
                    Step := Step::Start
                else
                    Step := Step::Step3;
            Step::Step3:
                if Backwards then
                    Step := Step::Step2
                else
                    Step := Step::Finish;
        end;

        EnableControls();
    end;

    local procedure ValidateSteps(SystemInvoked: Boolean)
    begin
        if SystemInvoked then
            exit;

        case Step of
            Step::Step2:
                ValidateStep2();
        end;
    end;

    local procedure ValidateStep2()
    var
        EmailRequiredErr: Label 'Contact email is required.';
    begin
        if GlobalContactEmail = '' then
            Error(EmailRequiredErr);
    end;

    local procedure SaveConfiguration()
    begin
        // Save bank-specific configuration
        GlobalBank."Contact Email" := GlobalContactEmail;
        GlobalBank."Company Name" := GlobalCompanyName;
        GlobalBank.Modify();
    end;
}
```

---

## Enum Registration

Add the bank to `CommunicationType.Enum.al`:

```al
enum 71553577 "CTS-CB Communication Type" implements
    "CTS-CB ICommunicationType Auth",
    "CTS-CB ICommunicationType Export",
    "CTS-CB ICommunicationType Import",
    "CTS-CB IAssisted Bank Account Setup",
    // ... other interfaces
{
    // ... existing values ...

    value(XX; {BankName})
    {
        Caption = '{BankName}';
        Implementation =
            "CTS-CB ICommunicationType Auth" = "CTS-CB {BankName} Auth",
            "CTS-CB ICommunicationType Export" = "CTS-CB {BankName} Export",
            "CTS-CB ICommunicationType Import" = "CTS-CB {BankName} Import",
            "CTS-CB IAssisted Bank Account Setup" = "CTS-CB {BankName} Assist Setup";
    }
}
```

---

## File Locations

| Component | Path |
|-----------|------|
| Setup Codeunit | `base-application/Setup/Codeunits/{BankName}AssistSetup.Codeunit.al` |
| Setup Page | `base-application/Setup/Pages/BankSystemPages/{BankName}AssistSetup.Page.al` |
| Step Enum | `base-application/Setup/Enums/{BankName}SetupStep.Enum.al` (optional) |
| Interface | `base-application/Setup/Interfaces/IAssistedBankAccountSetup.Interface.al` |
| Comm Type Enum | `base-application/Bank Communication/Enums/CommunicationType.Enum.al` |

---

## Best Practices

1. **Always implement ClosedByFinish()** - Main wizard checks this to know if user completed
2. **Validate before moving forward** - Use ValidateSteps() with SystemInvoked parameter
3. **Support step skipping** - Auto-skip steps when conditions already met
4. **Use ShowMandatory** - Visual indicator for required fields
5. **Handle external auth** - Open hyperlinks for OAuth flows
6. **Save on Finish only** - Don't persist until user confirms

## Related Skills

- `assisted-setup-wizard` - General wizard patterns and architecture
- `bank-system-setup-wizard` - Bank system configuration logic
- `new-bank-communication` - Authentication flow patterns
