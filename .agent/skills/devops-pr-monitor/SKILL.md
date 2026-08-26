---
name: devops-pr-monitor
description: Monitor consumer repository GHA PR check statuses, download failed logs, analyze errors, and automatically fix bugs or configurations in the Dagger module to make them pass.
---

# devops-pr-monitor Skill

## Role

The agent acts as a DevOps Automation and PR Monitoring Agent. It is responsible for checking GHA statuses in the consumer repository, analyzing log failures, identifying root causes within the Dagger module or workflow files, and applying automated fixes to get the builds passing.

## Help

When the user asks for help with this skill (e.g., "help devops-pr-monitor", "what does devops-pr-monitor do"), read this file dynamically and output:

- **Tasks**: Describe the monitoring, log fetching, diagnostic analysis, and code-fixing workflows.
- **Expected Inputs**: PR number or branch name of the consumer repository, repository scopes, and node tokens.
- **Parameters**: Optional custom branch names, check names, or target folders.
- **Example Prompts**:
  1. "Run devops-pr-monitor for staystack PR 340 --wait"
  2. "Monitor PR checks on branch fix-playwright-deps and fix any GHA bugs in node-checks.ts"
  3. "Audit GHA logs for the recent affected-tests run on PR 340 and update the daggerverse module"
- **Prerequisites**: Access to the GitHub CLI (`gh`), valid repository checkouts, and Dagger CLI.

## Purpose

To automate the feedback loop between Dagger module changes and consumer repository GHA verification, ensuring compilation, dependency, and configuration bugs are fixed automatically without requiring manual log analysis.

## Scope

- Querying GHA checks for pull requests in the staystack or consumer repositories.
- Downloading and parsing GHA logs from failed runs.
- Diagnosing errors related to self-referencing imports, cache volume mounting, GHA syntax, and lockfile layering.
- Modifying TS/JS implementation files in the Dagger module (`daggerverse`) to resolve discovered errors.
- Committing and pushing updates, then re-triggering and monitoring GHA checks until they succeed.

## Non-Scope

- Approving or merging PRs directly.
- Editing files unrelated to Dagger modules or CI configuration files.
- Modifying production package dependency versions (other than workspace configuration dependencies).

## Definitions

- **Consumer Repo**: The repository that imports and invokes the Dagger module (e.g., `@staytunedllp/staystack`).
- **Provider Repo**: The repository hosting the Dagger module source (e.g., `@staytunedllp/daggerverse`).
- **Affected Tests**: The selection mechanism that filters tests based on modified source code boundaries.
- **Stale Template**: A scenario where rendered workflow files on disk do not match their source templates under `src/stayarch/profiles/`.

## Activation

Activate this skill when the user requests monitoring GHA checks, fixing Dagger module/workflow bugs based on GHA failures, or automating GHA PR diagnostics for staystack / daggerverse.

Do not activate when the user asks for ordinary package features or structural database updates that have no relationship with the CI/CD pipeline or Dagger module.

## Inputs

Required:
- `prNumber` or `branchName`: Target pull request or branch to monitor.
- `consumerRepo`: Path or name of the consumer repository (default: `StaytunedLLP/staystack`).

Optional:
- `checkName`: Filter logs/results for a specific check (default: `affected-tests`).
- `--wait`: Polling flag to wait until GHA checks complete before exiting.

## Outputs

- A status report JSON file containing check results and parsed error messages under `.artifacts/pr-monitor/`.
- Modified source code files in the Dagger module repository.
- Successful GHA execution confirmation (green status).

## Workflows

### PR Monitoring & Auto-Fix Loop

1. **Intake & PR Identification**: Resolve the target PR number. If not provided, fetch the active PR number using `gh pr view --json number -q .number`.
2. **Run Monitor Script (with `--wait`)**: Execute `node .agent/skills/devops-pr-monitor/scripts/monitor-pr.js <prNumber> --wait` in the background.
3. **Analyze Exit Code**:
   - **Exit Code 0**: Report that all checks are successful (green) and exit.
   - **Exit Code 1**: Read the written JSON status report from `.artifacts/pr-monitor/pr-<prNumber>-status.json`.
4. **Locate Error and Logs**: Extract the failed job name, run link, and failed step logs.
5. **Classify and Fix**: Match the logs against the known failure modes under [Rules](#rules).
   - If missing symlinks or self-referencing package issues: Apply container path overrides.
   - If stale GHA workflow template: Synchronize the template file under `src/stayarch/profiles/` to align with root.
6. **Local Build Check**: Run `npm run build` in the provider repository (`daggerverse`) to make sure the fix compiles cleanly.
7. **Commit & Push**: Commit the fix in the provider repo and push it to the remote branch.
8. **Repeat Loop**: Run the background monitoring script again until the checks succeed.

## Rules

- **rule/gha-log-parsing**: Always parse GHA logs by looking for the `failing tests:` block or `Error [ERR_MODULE_NOT_FOUND]` lines first.
  - *Rationale*: Speeds up diagnostics by focusing on root cause assertions instead of setup output noise.
  - *Bad*: Scanning all lines sequentially without filtering.
  - *Good*: Extracting logs specifically starting from the `failing tests:` block.

- **rule/lockfile-layering**: Ensure Dagger workspaces copy package lockfiles separately before copying the entire source directory.
  - *Rationale*: Invalidates cache layers less frequently, saving minutes of container build time.
  - *Bad*: Copying the entire directory first and then running `npm ci`.
  - *Good*: Copying `package.json` and `package-lock.json` first, running `npm ci`, and then copying the rest.

- **rule/container-symlinking**: If the consumer repo imports its own package name self-referentially, the Dagger test container must explicitly symlink `node_modules/@staytunedllp/<package> -> ../..`.
  - *Rationale*: Node.js ESM loader will otherwise fail with `Cannot find package` when configs or sub-packages are executed.
  - *Bad*: Relying on default `npm ci` behavior when no workspaces are defined.
  - *Good*: Adding explicit `ln -sf` commands to the container workspace build script.

- **rule/stale-template-sync**: If the lint fails on stale arch config template file mismatch, edit the template file inside `src/stayarch/profiles/` rather than editing the root config file directly.
  - *Rationale*: Arch template synchronization will overwrite root files anyway, so template updates are the correct single-source-of-truth fixes.
  - *Bad*: Manually modifying the generated file in the root folder without updating the source template.
  - *Good*: Modifying the template file and then compiling the changes.

---

## Validation

Review the skill output to ensure:
- The JSON status report is fully populated with PR number, status, and failure logs.
- provider TS files compile without lint/tsc warnings.
- The GHA check status eventually turns green.

## Runtime Evaluation

After every run, log the results in this format:

```markdown
## Runtime Evaluation Report

| # | Category | Check | Result | Evidence |
|---|----------|-------|--------|----------|
| 1 | Outcome | Monitored check state correctly | PASS | Status matches GHA API |
| 2 | Outcome | Identified failed log lines | PASS | Found ERR_MODULE_NOT_FOUND |
| 3 | Process | Auto-applied compilation fix | PASS | Added container symlink |
| 4 | Style | No placeholders or TODOs | PASS | Code is clean and complete |
```

## Eval Strategy

Test the monitoring script and workflows using mock GHA runs:
- **Mock Success**: Run monitor script against a successful PR and verify exit code is 0.
- **Mock Failure**: Run monitor script against a failing PR and verify it exits with code 1 and writes log details.

## Directory & Anatomy Specification

```text
devops-pr-monitor/
├── SKILL.md                 # Frontmatter + Rules + Workflows
├── scripts/
│   └── monitor-pr.js        # Log downloader and PR status fetcher
└── evals/
    └── evals.json           # Trigger and execution assertions
```

## Resources

- [stayskill Skill](file:///Users/macmini-01/Downloads/gh-abhayraj-yadav-st4/StaytunedLLP/staystack/.agents/skills/stayskill/SKILL.md)
