# Create Pull Request in Azure DevOps

Creates a pull request in Azure DevOps by reusing the existing PR message generation logic and reading repository configuration from workflow-config.json.

## Usage

```bash
/FinishWork:fw-create-pr [work-item-ids]
```

**Parameters:**
- `work-item-ids` (optional): Azure DevOps work item ID(s) to link to the PR. Can be:
  - Single ID: `72245`
  - Multiple IDs (comma-separated): `72245,72246,72247`
  - If not provided, you'll be prompted
- `testEnvironmentBlock` (optional, context only — never a command-line arg): A pre-formatted test-environment block (name, URL, username, password) supplied by `fw-start.md` Step 3.6 when the user opted to include one. This is appended directly to the PR description in Step 3.5 below. It is passed as in-memory context between skill invocations in the same session — it is **never** read from, or written to, the git commit message or any file. If `fw-create-pr` is invoked standalone with no such context, no test-environment section is added (there is no commit message to parse it from).

## What This Command Does

1. Validates you're on a feature branch (not main)
2. Checks that commits exist on your branch
3. Reads repository configuration from workflow-config.json
4. Generates PR message by calling `/FinishWork:fw-step4-pullRequest`
5. Optionally links to a work item
6. Creates the pull request in Azure DevOps
7. Sets any linked work item(s) to **Active**
8. Displays PR URL and assigned reviewers

---

## Step 1: Validate Prerequisites

### Check Current Branch
```bash
git branch --show-current
```

**If on main or master:**
```markdown
## Error: Cannot Create PR from Main Branch

You are currently on the '{branch}' branch.

**Action Required:**
Pull requests must be created from a feature branch, not from main.

**Options:**
1. If you have uncommitted changes:
   - Create a feature branch: `git checkout -b feature/your-branch-name`
   - Stage and commit your changes
   - Run this command again

2. If you want to create a PR for existing work:
   - Switch to your feature branch: `git checkout your-branch-name`
   - Run this command again
```

Stop execution - do not proceed to next step.

### Check Commits Ahead of Main
```bash
git log main..HEAD --oneline
```

**If no commits:**
```markdown
## Error: No Commits on Branch

Your branch '{branch}' has no commits ahead of main.

**Action Required:**
1. Make your code changes
2. Stage changes: `git add .`
3. Commit changes: `git commit -m "Your message"`
4. Run this command again

Or if you've already pushed commits, ensure your local branch is up to date:
`git pull origin {branch}`
```

Stop execution - do not proceed to next step.

---

## Step 2: Read Repository Configuration

### Read Config File
Use the Read tool to read `.claude/workflow-config.json`.

### Extract Repository ID
Parse JSON and extract: `config.azureDevOps.repository.id`

**If repository.id IS found:**
- Store repository ID
- Proceed to Step 3

**If repository.id NOT found or config file doesn't exist:**

#### List Available Repositories
Call `mcp__azureDevOps__list_repositories` to get all repositories.

**If no repositories returned:**
```markdown
## Error: No Repositories Found

No repositories were found in the Azure DevOps project.

**Action Required:**
1. Verify you have access to the Azure DevOps project
2. Check that repositories exist in the project
3. Run this command again
```
Stop execution - do not proceed.

#### Display Selection Menu
```markdown
## Repository Configuration Required

No repository ID is configured. Please select from available repositories:

{For each repository, numbered starting at 1:}
{n}. {repository.name}
    ID: {repository.id}

Enter the number of your repository:
```

#### Process User Selection
- Validate selection is a valid number within the range 1 to {total repositories}
- If invalid, re-prompt with valid range
- Get selected repository's `id` and `name`

#### Update Configuration
Read current config (if exists) or create new config object.
Update/add the repository section while preserving existing settings (like areaPath):

```json
{
  "azureDevOps": {
    "areaPath": "{keep existing value if present}",
    "repository": {
      "name": "{selected repository name}",
      "id": "{selected repository id}"
    }
  }
}
```

Use Write tool to save updated config to `.claude/workflow-config.json`.

#### Confirm to User
```markdown
## Repository Configured

Repository **{name}** has been saved to workflow-config.json.

Continuing with PR creation...
```

- Store repository ID
- Proceed to Step 3

---

## Step 3: Generate PR Message

### Invoke Message Generation Command

**Call:** `/FinishWork:fw-step4-pullRequest`

This command will analyze your staged/committed changes and generate a message in this format:

```
### Commit Message (exactly as it will appear):

[Title Line]

- [Bullet 1]
- [Bullet 2]
- [Bullet 3]
...
```

### Parse the Output

**IMPORTANT - NO ATTRIBUTION IN PR:**
When parsing the commit message output:
- Extract the title and the bullet points only
- Do NOT include any "Co-Authored-By" lines
- Do NOT include any attribution text (e.g., "Claude Opus 4.5", "Claude Code")
- STOP parsing before any "Co-Authored-By" or attribution lines — everything before that line (the bullets) belongs in the PR description

The commit message never contains credentials or environment details — Step 3.6 of `fw-start.md` keeps those out of git history entirely. If a test environment was included for this run, it arrives separately as `testEnvironmentBlock` context (see Step 3.5 below), not by parsing the commit.

**Extract Title:**
- Skip lines until you see a line that is NOT a header/separator
- After "### Commit Message (exactly as it will appear):", skip empty lines
- First non-empty, non-header line = Title
- Remove any leading/trailing whitespace

**Extract Description:**
- Take every line AFTER the title and BEFORE the first "Co-Authored-By"/attribution line — verbatim.
- This means: keep the change-summary bullets (`- ...`) in bullet format.
- The ONLY thing stripped is the trailing `Co-Authored-By:`/attribution line(s).
- The result (bullets) is the base PR description; markdown is supported by Azure DevOps. Step 3.5 below may append a test-environment section to it.

**Example Parsing:**

**Input from fw-step4-pullRequest:**
```
### Commit Message (exactly as it will appear):

Store and download EBICS initialization letter PDF from BanksAPI

- Added PDF blob field to Bank table to store initialization letters
- Added SavePDFInFileArchive procedure to extract and decode PDF from BanksAPI response
- Added ModifyBank codeunit for background Bank record updates with isolated permissions
```

**Parsed Output:**
- Title: `"Store and download EBICS initialization letter PDF from BanksAPI"`
- Description:
  ```
  - Added PDF blob field to Bank table to store initialization letters
  - Added SavePDFInFileArchive procedure to extract and decode PDF from BanksAPI response
  - Added ModifyBank codeunit for background Bank record updates with isolated permissions
  ```

---

## Step 3.5: Append Test Environment Block to PR Description (if provided)

**Purpose:** If `fw-start.md` Step 3.6 collected a test environment for this run, its credentials go into the PR description here — directly, via the Azure DevOps API call in Step 5. They never pass through git.

**Condition:** Only runs if `testEnvironmentBlock` context was supplied by the caller (see Usage above). If this skill is invoked standalone with no such context, skip this step — the description stays as parsed in Step 3.

**Action:** Append the supplied block to the description parsed in Step 3, separated by a blank line:

```
{description from Step 3}

{testEnvironmentBlock}
```

`testEnvironmentBlock` already contains its own `---` separator and `**Test Environment**` header (see `fw-start.md` Step 3.6), so no additional formatting is needed here — just concatenate.

**Example (combined description used in Step 5):**
```
- Added PDF blob field to Bank table to store initialization letters
- Added SavePDFInFileArchive procedure to extract and decode PDF from BanksAPI response

---

**Test Environment**

- Environment: PR-EBICS-2026-06
- URL: https://demoportaldev.continiaonline.com/abc-123
- Username: Rf
- Password: Rf1234!
```

---

## Step 4: Handle Work Item Linking

### Check for Command Argument

**If work item ID(s) were provided as argument:**
- Parse the argument:
  - If it contains commas (e.g., "72245,72246,72247"):
    - Split by comma
    - Trim whitespace from each ID
    - Validate each is a number
    - Store as array: `workItemRefs = [72245, 72246, 72247]`
  - If single ID (e.g., "72245"):
    - Validate it's a number
    - Store as array: `workItemRefs = [72245]`
- Skip to Step 5

**If work item ID(s) were NOT provided:**
- Proceed to interactive prompt below

### Interactive Work Item Prompt

**Ask the user:**

```markdown
## Work Item Linking (Optional)

Do you want to link this PR to work item(s)?

**Options:**

1 - [Yes] - Enter work item ID(s)
2 - [No] - Create PR without work item link

Enter your choice:
```

**If user selects 1 (Yes):**
```markdown
**Enter work item ID(s):**
(Single ID: 72245, or comma-separated for multiple: 72245,72246,72247)
```

Wait for user input, then:
- Parse input (handle both single and comma-separated)
- Validate each is a number
- Store as array

**If user selects 2 (No):**
- Set workItemRefs to empty array `[]`
- Proceed to Step 5

---

## Step 5: Create Pull Request

### Get Current Branch Name
```bash
git branch --show-current
```

### Prepare API Call

**Repository ID:** Read from config (Step 2)
**Title:** Parsed from fw-step4-pullRequest (Step 3)
**Description:** Parsed bullets from fw-step4-pullRequest (Step 3), plus the test-environment block from Step 3.5 if one was supplied
**Source Branch:** `refs/heads/{current-branch}` (from git command above)
**Target Branch:** `refs/heads/main` (Continia Banking default)
**Work Items:** Array with work item ID(s) - can contain single or multiple IDs, or empty array

### Call Azure DevOps API

Use `mcp__azureDevOps__create_pull_request`:

```json
{
  "repositoryId": "{from config - e.g., a838fce3-3b9c-4c78-beec-cb4cf5983144}",
  "title": "{parsed title}",
  "description": "{parsed description - bullets only}",
  "sourceRefName": "refs/heads/{current-branch}",
  "targetRefName": "refs/heads/main",
  "workItemRefs": [{work-item-id}]  // Or [] if no work item
}
```

**Example with single work item:**
```json
{
  "repositoryId": "a838fce3-3b9c-4c78-beec-cb4cf5983144",
  "title": "Store and download EBICS initialization letter PDF from BanksAPI",
  "description": "- Added PDF blob field to Bank table to store initialization letters\n- Added SavePDFInFileArchive procedure to extract and decode PDF from BanksAPI response\n- Added ModifyBank codeunit for background Bank record updates with isolated permissions",
  "sourceRefName": "refs/heads/Userstory/RF/SaveEbicsPDF",
  "targetRefName": "refs/heads/main",
  "workItemRefs": [72245]
}
```

**Example with multiple work items:**
```json
{
  "repositoryId": "a838fce3-3b9c-4c78-beec-cb4cf5983144",
  "title": "Add multi-bank system support with payment method conflict resolution",
  "description": "- Added bank provider support for Nordea and Danske Bank\n- Implemented payment method conflict resolution logic\n- Added Bank System Setup Wizard for multi-bank configuration",
  "sourceRefName": "refs/heads/feature/multi-bank-support",
  "targetRefName": "refs/heads/main",
  "workItemRefs": [72245, 72246, 72247]
}
```

**Example without work item:**
```json
{
  "repositoryId": "a838fce3-3b9c-4c78-beec-cb4cf5983144",
  "title": "Fix typo in Bank Card caption",
  "description": "- Fixed typo in Bank Card page caption",
  "sourceRefName": "refs/heads/fix/bank-card-typo",
  "targetRefName": "refs/heads/main",
  "workItemRefs": []
}
```

---

## Step 5.5: Ensure Linked Work Items Are Active (safety-net)

**Purpose:** Work items are normally set to **Active** at the moment they are created or updated (see `fw-start.md` Step 3.5 — Flow A update and Flow B create). This step is an idempotent safety-net for the case where `fw-create-pr` is invoked standalone (outside the full `fw-start` flow), so a linked work item might still be in `New`. Any work item attached to a PR is being actively worked on, so its state must be **Active**.

**Condition:** Only runs if `workItemRefs` is non-empty. If `workItemRefs` is `[]`, skip this step entirely. When the work item was already activated in Step 3.5, the fetch in step 1 below finds it already `Active` and this step is a no-op.

**For each work item ID in `workItemRefs`:**

1. Fetch the current state with `mcp__azureDevOps__get_work_item` (read `System.State`).
2. If the state is already `Active`, skip it (no-op).
3. Otherwise, set it to `Active` using `mcp__azureDevOps__update_work_item`:

```json
{
  "workItemId": {work-item-id},
  "updates": [
    {
      "op": "replace",
      "path": "/fields/System.State",
      "value": "Active"
    }
  ]
}
```

**Notes:**
- This applies the rule literally: a work item linked to the PR ends up `Active`, including ones that were previously `New`, `Resolved`, or `Closed`.
- **Never fail the workflow on a state-transition error.** The PR has already been created at this point. If a work item is locked, you lack permission, or the process template rejects the transition, log a warning and continue with the remaining IDs. Surface which items could not be set to `Active` in the Step 6 output.

---

## Step 6: Display Results

### Parse API Response

Extract from the Azure DevOps response:
- Pull request ID
- Pull request URL
- Source and target branch names
- Reviewers array
- Linked work items (and which were set to Active in Step 5.5)

### Format Output

```markdown
## ✅ Pull Request Created Successfully!

**PR #{pullRequestId}** - {title}

**URL:** {webUrl or html link}

**Branch:** {sourceRefName} → {targetRefName}
**Status:** Active (awaiting review)
{If work items linked: **Linked Work Items:** {comma-separated list with # prefix, e.g., #72245, #72246, #72247} — set to Active}
{If any work item could NOT be set to Active: **⚠️ Could not set to Active:** {comma-separated list with # prefix and reason}}

### Reviewers Assigned:
{For each reviewer:}
- {displayName} ({uniqueName})

### Next Steps:
- PR is ready for team review
- Reviewers have been notified
- CI/CD pipelines will run automatically
- View PR: {url}
```

**Example Output (single work item):**

```markdown
## ✅ Pull Request Created Successfully!

**PR #40640** - Store and download EBICS initialization letter PDF from BanksAPI

**URL:** https://dev.azure.com/continia-software/fe625cb4-1b5a-47d3-ac70-74d6ff992324/_git/Continia%20Banking/pullrequest/40640

**Branch:** refs/heads/Userstory/RF/SaveEbicsPDF → refs/heads/main
**Status:** Active (awaiting review)
**Linked Work Items:** #72245 — set to Active

### Reviewers Assigned:
- Artūras Sagidulinas (ars@continia.com)
- Tommy Gundestrup Schou (ts@continia.com)
- Andree Steding (anst@continia.com)
- Morten Kim Krebs (mks@continia.com)
- Martin Holm (mh@continia.com)
- Ugnius Ignatavicius (ugi@continia.com)
- Dennis Juul Knudsen (dk@continia.com)

### Next Steps:
- PR is ready for team review
- Reviewers have been notified
- CI/CD pipelines will run automatically
- View PR: https://dev.azure.com/continia-software/fe625cb4-1b5a-47d3-ac70-74d6ff992324/_git/Continia%20Banking/pullrequest/40640
```

**Example Output (multiple work items):**

```markdown
## ✅ Pull Request Created Successfully!

**PR #40641** - Add multi-bank system support with payment method conflict resolution

**URL:** https://dev.azure.com/continia-software/fe625cb4-1b5a-47d3-ac70-74d6ff992324/_git/Continia%20Banking/pullrequest/40641

**Branch:** refs/heads/feature/multi-bank-support → refs/heads/main
**Status:** Active (awaiting review)
**Linked Work Items:** #72245, #72246, #72247 — set to Active

### Reviewers Assigned:
- Artūras Sagidulinas (ars@continia.com)
- Tommy Gundestrup Schou (ts@continia.com)
- Andree Steding (anst@continia.com)
- Morten Kim Krebs (mks@continia.com)
- Martin Holm (mh@continia.com)
- Ugnius Ignatavicius (ugi@continia.com)
- Dennis Juul Knudsen (dk@continia.com)

### Next Steps:
- PR is ready for team review
- Reviewers have been notified
- CI/CD pipelines will run automatically
- View PR: https://dev.azure.com/continia-software/fe625cb4-1b5a-47d3-ac70-74d6ff992324/_git/Continia%20Banking/pullrequest/40640
```

---

## Error Handling Summary

### Error 1: On Main Branch
**Trigger:** Current branch is main or master
**Action:** Display error and stop
**Message:** Explain that PRs must be from feature branches

### Error 2: No Commits
**Trigger:** `git log main..HEAD` returns empty
**Action:** Display error and stop
**Message:** Explain that changes must be committed first

### Error 3: No Repositories Found
**Trigger:** `mcp__azureDevOps__list_repositories` returns empty list
**Action:** Display error and stop
**Message:** Explain that no repositories were found and suggest checking access

### Error 4: Azure DevOps API Failure
**Trigger:** create_pull_request API call fails
**Action:** Display API error message
**Message:** Include error details and suggestions (permissions, network, etc.)

---

## Implementation Notes

### Message Parsing Strategy

The fw-step4-pullRequest command outputs text that looks like this:

```
Some preamble text...

### Commit Message (exactly as it will appear):

Title Line Here

- Bullet point 1
- Bullet point 2
- Bullet point 3

Some trailing text...
```

**Parsing approach:**
1. Find the line containing "### Commit Message (exactly as it will appear):"
2. Skip that line and any empty lines after it
3. Next non-empty line = Title
4. Collect all following lines starting with "- " = Description bullets

### Config File Structure

The workflow-config.json should have this structure after update:

```json
{
  "azureDevOps": {
    "areaPath": "Continia Software\\Continia Banking",
    "repository": {
      "name": "Continia Banking",
      "id": "a838fce3-3b9c-4c78-beec-cb4cf5983144"
    }
  }
}
```

**Accessing in command:**
- Read file with Read tool
- Parse JSON
- Access via: `config.azureDevOps.repository.id`
- Validate it exists before using

### Work Item Handling

**Four scenarios:**

1. **Single work item provided as argument:** `/FinishWork:fw-create-pr 72245`
   - Parse: `72245`
   - Use: `workItemRefs: [72245]`

2. **Multiple work items provided as argument:** `/FinishWork:fw-create-pr 72245,72246,72247`
   - Parse: Split by comma, trim whitespace
   - Validate: Each is numeric
   - Use: `workItemRefs: [72245, 72246, 72247]`

3. **User prompted and provides ID(s):**
   - Prompt: "Enter work item ID(s): (Single: 72245, Multiple: 72245,72246,72247)"
   - Parse and validate input
   - Use: `workItemRefs: [parsed IDs]`

4. **User chooses not to link:**
   - Use: `workItemRefs: []`
   - PR created without work item connection

### Branch Name Formatting

Azure DevOps API requires `refs/heads/` prefix:
- Current branch from git: `Userstory/RF/SaveEbicsPDF`
- Format for API: `refs/heads/Userstory/RF/SaveEbicsPDF`
- Target branch: `refs/heads/main`

---

## Quick Reference

### Command Invocation Examples

```bash
# With single work item (Flow A - updating existing work item)
/FinishWork:fw-create-pr 72245

# With multiple work items (Flow B - created multiple work items)
/FinishWork:fw-create-pr 72245,72246,72247

# Without work item (will prompt)
/FinishWork:fw-create-pr

# After prompt, user can choose to link (single or multiple) or skip
```

### Expected Flow

```
User runs: /FinishWork:fw-create-pr
↓
[1] Check branch (not main) ✓
[2] Check commits exist ✓
[3] Read repository ID from config
    - If configured: use stored ID ✓
    - If NOT configured: list repos → user selects → save to config ✓
[4] Generate message via fw-step4-pullRequest ✓
[5] Prompt for work item (user chooses Yes/No)
[6] Create PR in Azure DevOps ✓
[7] Display PR URL and reviewers ✓
```

### Configuration Prerequisites

**First-time use:**
- Repository ID is automatically configured on first run
- You'll be prompted to select from available repositories
- Selection is saved to `.claude/workflow-config.json` for future use

**Manual configuration (optional):**
If you prefer to pre-configure, add to `.claude/workflow-config.json`:
```json
{
  "azureDevOps": {
    "repository": {
      "name": "Continia Banking",
      "id": "{repository-id-from-azure-devops}"
    }
  }
}
```

---

## Maintenance

- Keep repository ID in sync if repo changes (rare)
- Update target branch if default changes from `main`
- Add additional validation as needed
- Consider adding draft PR option in future
