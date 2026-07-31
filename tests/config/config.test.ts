import { describe, expect, it } from "bun:test";
import { loadConfig, buildTagWiql } from "../../src/config/index.ts";

const validEnv: Record<string, string> = {
  AZURE_DEVOPS_PAT: "test-pat-token",
  AZURE_DEVOPS_ORG: "my-org",
  AZURE_DEVOPS_PROJECT: "my-project",
  ANTHROPIC_API_KEY: "sk-ant-test",
  CONTINIA_API_TOKEN: "demoportal-test-token",
};

describe("loadConfig", () => {
  it("returns correct AppConfig for valid env", () => {
    const config = loadConfig(validEnv);

    expect(config.pat).toBe("test-pat-token");
    expect(config.org).toBe("my-org");
    expect(config.orgUrl).toBe("https://dev.azure.com/my-org");
    expect(config.project).toBe("my-project");
  });

  it("throws when AZURE_DEVOPS_PAT is missing", () => {
    const env = { ...validEnv };
    delete env.AZURE_DEVOPS_PAT;
    expect(() => loadConfig(env)).toThrow("Invalid configuration");
  });

  it("throws when AZURE_DEVOPS_ORG is missing", () => {
    const env = { ...validEnv };
    delete env.AZURE_DEVOPS_ORG;
    expect(() => loadConfig(env)).toThrow("Invalid configuration");
  });

  it("throws when AZURE_DEVOPS_PROJECT is missing", () => {
    const env = { ...validEnv };
    delete env.AZURE_DEVOPS_PROJECT;
    expect(() => loadConfig(env)).toThrow("Invalid configuration");
  });

  // Each bot carries its own key; without this the failure surfaces deep inside
  // the first agent run instead of on boot.
  it("throws naming ANTHROPIC_API_KEY when it is absent", () => {
    const env = { ...validEnv };
    delete env.ANTHROPIC_API_KEY;
    expect(() => loadConfig(env)).toThrow("ANTHROPIC_API_KEY");
  });

  it("rejects a blank ANTHROPIC_API_KEY", () => {
    expect(() => loadConfig({ ...validEnv, ANTHROPIC_API_KEY: "" })).toThrow(
      "ANTHROPIC_API_KEY is required",
    );
  });

  // Without this the token's absence only surfaces in the verify phase, after a
  // full plan and implement have already run.
  it("requires CONTINIA_API_TOKEN when the verify phase will run", () => {
    const env = { ...validEnv };
    delete env.CONTINIA_API_TOKEN;
    expect(() => loadConfig(env)).toThrow("CONTINIA_API_TOKEN");
  });

  it("does not require CONTINIA_API_TOKEN when the build/test phase is skipped", () => {
    const env: Record<string, string> = { ...validEnv, SKIP_BUILD_TEST: "true" };
    delete env.CONTINIA_API_TOKEN;
    const config = loadConfig(env);
    expect(config.skipBuildTest).toBe(true);
  });

  it("leaves seed repo paths undefined unless configured", () => {
    const config = loadConfig(validEnv);
    expect(config.repos.banking.seedPath).toBeUndefined();
    expect(config.repos.setupFiles.seedPath).toBeUndefined();
  });

  it("parses seed repo paths and ignores blank ones", () => {
    const config = loadConfig({
      ...validEnv,
      BANKING_SEED_REPO: "/repos/continia-banking",
      SETUP_FILES_SEED_REPO: "   ",
    });
    expect(config.repos.banking.seedPath).toBe("/repos/continia-banking");
    expect(config.repos.setupFiles.seedPath).toBeUndefined();
  });

  it("applies default values when optional vars are absent", () => {
    const config = loadConfig(validEnv);

    expect(config.pollIntervalMinutes).toBe(5);
    expect(config.triggerTag).toBe("create-new-comm");
    expect(config.waitingTag).toBe("create-new-comm-waiting");
    expect(config.maxClarifyRounds).toBe(3);
    expect(config.stateDir).toBe("/data/state");
    expect(config.skillsSourceDir).toBe("/app/.claude");
    expect(config.continiaCliPath).toBe("/usr/local/bin/continia");
  });

  it("derives the WIQL query from the trigger tag", () => {
    const config = loadConfig(validEnv);
    expect(config.wiqlQuery).toContain("[System.Tags] CONTAINS 'create-new-comm'");
    expect(config.wiqlQuery).toContain("[System.State] <> 'Closed'");
  });

  it("re-derives the WIQL query when the trigger tag changes", () => {
    const config = loadConfig({ ...validEnv, TRIGGER_TAG: "build-me" });
    expect(config.wiqlQuery).toContain("[System.Tags] CONTAINS 'build-me'");
    expect(config.wiqlQuery).not.toContain("create-new-comm");
  });

  it("uses a custom WIQL query when provided", () => {
    const env = {
      ...validEnv,
      AZURE_DEVOPS_WIQL_QUERY:
        "SELECT [System.Id] FROM workitems WHERE [System.State] = 'Active'",
    };
    const config = loadConfig(env);
    expect(config.wiqlQuery).toBe(
      "SELECT [System.Id] FROM workitems WHERE [System.State] = 'Active'",
    );
  });

  it("falls back to the tag query when the override is blank", () => {
    const config = loadConfig({ ...validEnv, AZURE_DEVOPS_WIQL_QUERY: "   " });
    expect(config.wiqlQuery).toBe(buildTagWiql("create-new-comm"));
  });

  it("overrides defaults when optional vars are provided", () => {
    const env = {
      ...validEnv,
      POLL_INTERVAL_MINUTES: "30",
      CLAUDE_MODEL: "claude-sonnet-5",
      STATE_DIR: "/tmp/state",
      MAX_CLARIFY_ROUNDS: "1",
      BRANCH_PREFIX: "feature/bot",
    };

    const config = loadConfig(env);

    expect(config.pollIntervalMinutes).toBe(30);
    expect(config.claudeModel).toBe("claude-sonnet-5");
    expect(config.stateDir).toBe("/tmp/state");
    expect(config.maxClarifyRounds).toBe(1);
    expect(config.branchPrefix).toBe("feature/bot");
  });

  it("reads repo targets into the repos map", () => {
    const config = loadConfig({
      ...validEnv,
      BANKING_REPO_ID: "abc-123",
      BANKING_REPO_NAME: "Continia Banking",
      SETUP_FILES_REPO_ID: "def-456",
      SETUP_FILES_REPO_NAME: "Setup Files",
      SETUP_FILES_DEFAULT_BRANCH: "master",
    });

    expect(config.repos.banking).toEqual({
      key: "banking",
      id: "abc-123",
      name: "Continia Banking",
      defaultBranch: "main",
    });
    expect(config.repos.setupFiles).toEqual({
      key: "setupFiles",
      id: "def-456",
      name: "Setup Files",
      defaultBranch: "master",
    });
  });

  describe("boolean flags", () => {
    it("defaults DRAFT_PR to true and SKIP_BUILD_TEST to false", () => {
      const config = loadConfig(validEnv);
      expect(config.draftPr).toBe(true);
      expect(config.skipBuildTest).toBe(false);
    });

    it.each([
      ["true", true],
      ["1", true],
      ["yes", true],
      ["ON", true],
      ["false", false],
      ["0", false],
      ["nonsense", false],
    ])("parses SKIP_BUILD_TEST=%s as %p", (value, expected) => {
      const config = loadConfig({ ...validEnv, SKIP_BUILD_TEST: value });
      expect(config.skipBuildTest).toBe(expected);
    });

    it("treats a blank value as the default", () => {
      const config = loadConfig({ ...validEnv, DRAFT_PR: "" });
      expect(config.draftPr).toBe(true);
    });
  });

  it("parses PR_REVIEWER_IDS into a trimmed list", () => {
    const config = loadConfig({ ...validEnv, PR_REVIEWER_IDS: "a, b ,, c" });
    expect(config.reviewerIds).toEqual(["a", "b", "c"]);
  });

  it("yields an empty reviewer list when unset", () => {
    expect(loadConfig(validEnv).reviewerIds).toEqual([]);
  });

  it("rejects a non-positive poll interval", () => {
    expect(() => loadConfig({ ...validEnv, POLL_INTERVAL_MINUTES: "0" })).toThrow(
      "Invalid configuration",
    );
  });

  it("derives orgUrl from org name", () => {
    const env = { ...validEnv, AZURE_DEVOPS_ORG: "contoso" };
    const config = loadConfig(env);
    expect(config.orgUrl).toBe("https://dev.azure.com/contoso");
  });
});
