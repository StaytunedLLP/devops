import {
  Container,
  Directory,
  File,
  Secret,
  Workspace,
  argument,
  check,
  func,
  object,
} from "@dagger.io/dagger";
import { changedBetween } from "#checks/git-changed.js";
import { checkPrTitleFromEvent } from "#checks/pr-checks.js";
import {
  deleteFirebaseApphostingBackend,
  deployFirebaseApphostingProject,
  deployFirebaseApphostingPipeline,
} from "#firebase/app-hosting.js";
import { firebaseAppHostingBase } from "#firebase/base.js";
import { runNodeChecks } from "#checks/node-checks.js";
import { prepareNodeWorkspace } from "#copilot/prepare-node-workspace.js";
import { firebaseDeployWebhostingPipeline } from "#firebase/pipeline.js";
import {
  gitDiffBetweenCommits,
  gitDiffPrevious,
  gitDiffStaged,
} from "#git/index.js";
import { releasePackage } from "#publish/index.js";
import { parseReleaseBump } from "#publish/helpers.js";
import type { ReleasePackageAction } from "#publish/types.js";
import { runPlaywrightTests } from "#playwright/index.js";

const DEFAULT_CHECK_WORKSPACE_EXCLUDES = [
  "dagger",
  ".dagger",
  "dist",
  "node_modules",
  ".artifacts",
];

/**
 * Collection of repository checks and validation tools for Node.js projects.
 *
 * This sub-module provides high-performance, cache-efficient workflows for
 * common CI tasks such as formatting, linting, testing, and building.
 * It is designed to work seamlessly in both standard repositories and monorepos.
 */
@object()
export class Checks {
  private readonly source?: Directory;
  private readonly nodeAuthToken?: Secret;
  private readonly packagePaths: string;
  private readonly registryScope: string;
  private readonly checkBase: string;
  private readonly changedFiles: string;
  private readonly nodeMaxOldSpaceMb: number;

  constructor(
    source?: Directory,
    nodeAuthToken?: Secret,
    packagePaths = ".",
    registryScope = "staytunedllp",
    base = "origin/main",
    changedFiles = "",
    nodeMaxOldSpaceMb = 0,
  ) {
    this.source = source;
    this.nodeAuthToken = nodeAuthToken;
    this.packagePaths = packagePaths;
    this.registryScope = registryScope;
    this.checkBase = base;
    this.changedFiles = changedFiles;
    this.nodeMaxOldSpaceMb = nodeMaxOldSpaceMb;
  }

  private get heap(): number | undefined {
    return this.nodeMaxOldSpaceMb > 0 ? this.nodeMaxOldSpaceMb : undefined;
  }

  private resolveSource(source?: Directory): Directory {
    const resolved = source ?? this.source;
    if (!resolved) {
      throw new Error(
        "No source directory is bound. Use dagger check from a workspace or pass source to the function.",
      );
    }
    return resolved;
  }

  private resolveNodeAuthToken(nodeAuthToken?: Secret): Secret | undefined {
    return nodeAuthToken ?? this.nodeAuthToken;
  }

  /**
   * Fully prepares a Node.js workspace environment by:
   * 1. Synchronizing repository manifests (.npmrc, package-lock.json).
   * 2. Authenticating with the GitHub Packages registry.
   * 3. Mounting persistent cache volumes for maximum performance.
   * 4. Installing production and development dependencies via 'npm ci'.
   * 5. (Optional) Provisioning Playwright browsers and system dependencies.
   * 6. (Optional) Bootstrapping Firebase CLI tooling.
   *
   * @param source - Repository source directory to install into the workspace container.
   * @param nodeAuthToken - Optional secret token for GitHub Packages npm authentication. Required for private packages.
   * @param packagePaths - Relative path (or CSV list of paths) where npm installs should run. Defaults to the source root.
   * @param playwrightInstall - Enable to install Playwright browsers and OS-level system dependencies into the container.
   * @param firebaseTools - Enable to install the Firebase CLI (firebase-tools) into the prepared workspace.
   *
   * @example
   * dagger call checks install --source . --playwright-install
   */
  @check()
  @func()
  async install(
    @argument({
      defaultPath: ".",
      ignore: [".git", "dagger", "dist", "node_modules"],
    })
    source: Directory,
    nodeAuthToken?: Secret,
    packagePaths = ".",
    playwrightInstall = false,
    firebaseTools = false,
  ): Promise<Directory> {
    return prepareNodeWorkspace(source, nodeAuthToken, {
      packagePaths,
      playwrightInstall,
      firebaseTools,
    });
  }

  /**
   * Validates repository formatting using the standard `npm run format:check` command.
   *
   * @param source - Repository source directory to validate.
   * @param nodeAuthToken - Optional secret token for GitHub Packages npm authentication. Required for private packages.
   *
   * @example
   * dagger call checks format --source .
   */
  @check()
  @func({ cache: "never" })
  async formatFull(): Promise<void> {
    await runNodeChecks(this.resolveSource(), this.resolveNodeAuthToken(), {
      packagePaths: this.packagePaths,
      registryScope: this.registryScope,
      nodeMaxOldSpaceMb: this.heap,
      format: true,
      runAffected: false,
    });
  }

  @func()
  async format(
    @argument({
      defaultPath: ".",
      ignore: ["dagger", "dist", "node_modules"],
    })
    source: Directory,
    nodeAuthToken?: Secret,
    runAffected = false,
  ): Promise<void> {
    await runNodeChecks(
      this.resolveSource(source),
      this.resolveNodeAuthToken(nodeAuthToken),
      {
        packagePaths: this.packagePaths,
        registryScope: this.registryScope,
        nodeMaxOldSpaceMb: this.heap,
        format: true,
        runAffected,
      },
    );
  }

  @check()
  @func({ cache: "never" })
  async formatIncremental(): Promise<void> {
    await runNodeChecks(this.resolveSource(), this.resolveNodeAuthToken(), {
      packagePaths: this.packagePaths,
      registryScope: this.registryScope,
      nodeMaxOldSpaceMb: this.heap,
      format: true,
      runAffected: true,
      base: this.checkBase,
      changedFiles: this.changedFiles,
    });
  }

  @check()
  @func({ cache: "never" })
  async lintFull(): Promise<void> {
    await runNodeChecks(this.resolveSource(), this.resolveNodeAuthToken(), {
      packagePaths: this.packagePaths,
      registryScope: this.registryScope,
      nodeMaxOldSpaceMb: this.heap,
      lint: true,
      runAffected: false,
    });
  }

  @func()
  async lint(
    @argument({
      defaultPath: ".",
      ignore: ["dagger", "dist", "node_modules"],
    })
    source: Directory,
    nodeAuthToken?: Secret,
    runAffected = false,
  ): Promise<void> {
    await runNodeChecks(
      this.resolveSource(source),
      this.resolveNodeAuthToken(nodeAuthToken),
      {
        packagePaths: this.packagePaths,
        registryScope: this.registryScope,
        nodeMaxOldSpaceMb: this.heap,
        lint: true,
        runAffected,
      },
    );
  }

  @check()
  @func({ cache: "never" })
  async lintIncremental(): Promise<void> {
    await runNodeChecks(this.resolveSource(), this.resolveNodeAuthToken(), {
      packagePaths: this.packagePaths,
      registryScope: this.registryScope,
      nodeMaxOldSpaceMb: this.heap,
      lint: true,
      runAffected: true,
      base: this.checkBase,
      changedFiles: this.changedFiles,
    });
  }

  @check()
  @func({ cache: "never" })
  async buildFull(): Promise<void> {
    await runNodeChecks(this.resolveSource(), this.resolveNodeAuthToken(), {
      packagePaths: this.packagePaths,
      registryScope: this.registryScope,
      nodeMaxOldSpaceMb: this.heap,
      build: true,
      runAffected: false,
    });
  }

  @func()
  async build(
    @argument({
      defaultPath: ".",
      ignore: [".git", "dagger", "dist", "node_modules"],
    })
    source: Directory,
    nodeAuthToken?: Secret,
  ): Promise<void> {
    await runNodeChecks(
      this.resolveSource(source),
      this.resolveNodeAuthToken(nodeAuthToken),
      {
        packagePaths: this.packagePaths,
        registryScope: this.registryScope,
        nodeMaxOldSpaceMb: this.heap,
        build: true,
        runAffected: false,
      },
    );
  }

  @check()
  @func({ cache: "never" })
  async buildIncremental(): Promise<void> {
    await runNodeChecks(this.resolveSource(), this.resolveNodeAuthToken(), {
      packagePaths: this.packagePaths,
      registryScope: this.registryScope,
      nodeMaxOldSpaceMb: this.heap,
      build: true,
      runAffected: true,
      base: this.checkBase,
      changedFiles: this.changedFiles,
    });
  }

  @func()
  async typecheck(
    @argument({
      defaultPath: ".",
      ignore: [".git", "dagger", "dist", "node_modules"],
    })
    source: Directory,
    nodeAuthToken?: Secret,
  ): Promise<void> {
    await this.build(source, nodeAuthToken);
  }

  @check()
  @func({ cache: "never" })
  async testFull(): Promise<void> {
    await runNodeChecks(this.resolveSource(), this.resolveNodeAuthToken(), {
      packagePaths: this.packagePaths,
      registryScope: this.registryScope,
      nodeMaxOldSpaceMb: this.heap,
      test: true,
      runAffected: false,
    });
  }

  @func()
  async test(
    @argument({
      defaultPath: ".",
      ignore: ["dagger", "dist", "node_modules"],
    })
    source: Directory,
    nodeAuthToken?: Secret,
    runAffected = false,
    testScript = "test",
    base = "origin/main",
    changedFiles = "",
  ): Promise<void> {
    await runNodeChecks(
      this.resolveSource(source),
      this.resolveNodeAuthToken(nodeAuthToken),
      {
        packagePaths: this.packagePaths,
        registryScope: this.registryScope,
        nodeMaxOldSpaceMb: this.heap,
        test: true,
        runAffected,
        testScript,
        base,
        changedFiles,
      },
    );
  }

  @check()
  @func({ cache: "never" })
  async testIncremental(): Promise<void> {
    await runNodeChecks(this.resolveSource(), this.resolveNodeAuthToken(), {
      packagePaths: this.packagePaths,
      registryScope: this.registryScope,
      nodeMaxOldSpaceMb: this.heap,
      test: true,
      runAffected: true,
      testScript: "verify:incremental",
      base: this.checkBase,
      changedFiles: this.changedFiles,
    });
  }

  // The local profile: only the packages whose own files changed, for a
  // developer waiting on their own terminal. checks-reusable.yml maps
  // profile local to the -changed suffix and always runs all four names, so
  // every one of these has to exist even where it does no less work than its
  // -incremental sibling.
  //
  // format and lint genuinely do no less work. Their affected path runs the
  // repository's own format:incremental / lint:incremental, which filter to
  // changed files and never consult the dependency graph -- there is nothing
  // narrower to ask for. They delegate rather than pretending to differ, so
  // that a future divergence has one obvious place to happen.

  @check()
  @func({ cache: "never" })
  async formatChanged(): Promise<void> {
    await this.formatIncremental();
  }

  @check()
  @func({ cache: "never" })
  async lintChanged(): Promise<void> {
    await this.lintIncremental();
  }

  @check()
  @func({ cache: "never" })
  async buildChanged(): Promise<void> {
    await this.buildIncremental();
  }

  /**
   * Unlike the other three, this one is genuinely narrower: the affected-test
   * runtime is the only place the reverse dependency graph is walked, so
   * suppressing that expansion is what makes the local profile local.
   */
  @check()
  @func({ cache: "never" })
  async testChanged(): Promise<void> {
    await runNodeChecks(this.resolveSource(), this.resolveNodeAuthToken(), {
      packagePaths: this.packagePaths,
      registryScope: this.registryScope,
      nodeMaxOldSpaceMb: this.heap,
      test: true,
      runAffected: true,
      testScript: "verify:incremental",
      base: this.checkBase,
      changedFiles: this.changedFiles,
      includeDependents: false,
    });
  }

  /**
   * All four checks against one prepared workspace.
   *
   * The workflow runs `dagger check` once per check, so each of format, lint,
   * test and build materialises the workspace from scratch. Measured on
   * staystack: format alone cost 109s while checking nothing, and 95s while
   * checking two files -- almost all of it workspace setup rather than
   * checking. Four checks pay that four times.
   *
   * runNodeChecks already accepts every check in a single call and runs them as
   * sequential execs on one container, so the waste was never in the module. It
   * was in invoking the module four times.
   *
   * The trade is granularity: one check result in the UI instead of four. The
   * failing phase is still named in the log, and the order is cheapest first --
   * format, lint, test, build -- so a formatting slip still surfaces before the
   * long phases run.
   */
  @check()
  @func({ cache: "never" })
  async allIncremental(): Promise<void> {
    await runNodeChecks(this.resolveSource(), this.resolveNodeAuthToken(), {
      packagePaths: this.packagePaths,
      registryScope: this.registryScope,
      nodeMaxOldSpaceMb: this.heap,
      format: true,
      lint: true,
      test: true,
      build: true,
      runAffected: true,
      base: this.checkBase,
      changedFiles: this.changedFiles,
    });
  }

  /** All four checks, full scope, against one prepared workspace. */
  @check()
  @func({ cache: "never" })
  async allFull(): Promise<void> {
    await runNodeChecks(this.resolveSource(), this.resolveNodeAuthToken(), {
      packagePaths: this.packagePaths,
      registryScope: this.registryScope,
      nodeMaxOldSpaceMb: this.heap,
      format: true,
      lint: true,
      test: true,
      build: true,
      runAffected: false,
    });
  }

  /** All four checks, changed scope, against one prepared workspace. */
  @check()
  @func({ cache: "never" })
  async allChanged(): Promise<void> {
    await runNodeChecks(this.resolveSource(), this.resolveNodeAuthToken(), {
      packagePaths: this.packagePaths,
      registryScope: this.registryScope,
      nodeMaxOldSpaceMb: this.heap,
      format: true,
      lint: true,
      test: true,
      build: true,
      runAffected: true,
      base: this.checkBase,
      changedFiles: this.changedFiles,
      includeDependents: false,
    });
  }

  /**
   * Resolve the changed set from git, inside the engine.
   *
   * Returns JSON: added, modified, removed, and present (added + modified).
   *
   * The caller currently computes this on the host and passes a comma-joined
   * string. That string has to travel through a Dagger local default, where
   * `env://` is a *secret provider* URI -- it resolves for Secret arguments and
   * passes through verbatim for plain strings. The changed set is a string, so
   * it arrived as the literal "env://CHANGED_FILES" and every consumer failed
   * silently: the scoped scripts filtered the phantom path out and reported
   * "no changes -- skip", while staytest read it as a root-level change and
   * escalated to every package.
   *
   * Resolving here makes it a typed value that cannot quietly be the wrong
   * thing, needs no `.git` in the check container, and is cached on the commit
   * digests.
   *
   * Removed paths are reported but kept out of `present`, because prettier and
   * eslint error on a path that is not on disk. They are still worth surfacing:
   * the shell resolvers drop deletions entirely, so a delete-only change gets
   * no scoped checking at all.
   *
   * @example
   * dagger call checks changed-from-git --url https://github.com/o/r --base origin/main
   */
  @func()
  async changedFromGit(
    url: string,
    base = "origin/main",
    head?: string,
    token?: Secret,
  ): Promise<string> {
    const set = await changedBetween({ url, base, head, token });
    return JSON.stringify(set, null, 2);
  }
}

/**
 * Shared Dagger module for Node/TypeScript repository checks and deployment helpers.
 *
 * `Staydevops-TS` is a comprehensive toolkit designed to streamline CI/CD pipelines
 * for modern TypeScript applications. It provides a suite of high-level Dagger functions
 * for:
 *
 * - 🔍 **Repository Health**: Automated linting, formatting, and build verification.
 * - 🧪 **Advanced Testing**: Integrated Playwright E2E testing with built-in "Affected Test" discovery.
 * - 🚀 **Firebase Deployment**: Streamlined pipelines for Firebase Hosting and App Hosting.
 * - 📦 **Package Release Automation**: main-aware PR patch bumps and main-branch npm publishing.
 * - 📂 **Git Utilities**: Helpers for discovering changed files and diff ranges.
 *
 * Built with performance and security in mind, this module leverages Dagger's
 * advanced caching and secure secret handling to provide a robust foundation for
 * staytunedllp infrastructure and beyond.
 */
@object()
export class StaydevopsTs {
  private readonly workspace: Workspace;
  private readonly workspacePath: string;
  private readonly workspaceExcludes: string[];
  private readonly nodeAuthToken?: Secret;
  private readonly packagePaths: string;
  private readonly registryScope: string;
  private readonly checkBase: string;
  private readonly changedFiles: string;
  private readonly nodeMaxOldSpaceMb: number;

  constructor(
    ws: Workspace,
    workspacePath = "/",
    workspaceExcludes: string[] = DEFAULT_CHECK_WORKSPACE_EXCLUDES,
    packagePaths = ".",
    nodeAuthToken?: Secret,
    registryScope = "staytunedllp",
    base = "origin/main",
    changedFiles = "",
    nodeMaxOldSpaceMb = 0,
  ) {
    this.workspace = ws;
    this.workspacePath = workspacePath || "/";
    this.workspaceExcludes = workspaceExcludes;
    this.nodeAuthToken = nodeAuthToken;
    this.packagePaths = packagePaths;
    this.registryScope = registryScope;
    this.checkBase = base || "origin/main";
    this.changedFiles = changedFiles;
    this.nodeMaxOldSpaceMb = nodeMaxOldSpaceMb;
  }

  private resolveSource(): Directory {
    return this.workspace.directory(this.workspacePath, {
      exclude: this.workspaceExcludes,
      gitignore: true,
    });
  }

  /**
   * Validates the PR title according to Conventional Commits naming convention.
   *
   * @param eventFile - Optional GitHub event JSON file containing the PR title.
   * @param githubToken - Optional GitHub token to post a comment if validation fails.
   *
   * @example
   * dagger call check-pr-title --event-file=$GITHUB_EVENT_PATH --github-token=env:GITHUB_TOKEN
   */
  @func()
  async checkPrTitle(eventFile?: File, githubToken?: Secret): Promise<void> {
    await checkPrTitleFromEvent(eventFile, githubToken);
  }

  /**
   * Returns a Firebase App Hosting base container with firebase-tools installed and cached.
   */
  private base(): Container {
    return firebaseAppHostingBase();
  }

  /**
   * Returns the collection of repository checks.
   *
   * @example
   * dagger call checks lint --source .
   */
  @func()
  checks(): Checks {
    return new Checks(
      this.resolveSource(),
      this.nodeAuthToken,
      this.packagePaths,
      this.registryScope,
      this.checkBase,
      this.changedFiles,
      this.nodeMaxOldSpaceMb,
    );
  }

  /**
   * Returns repository checks with an explicit npm auth secret override.
   */
  @func()
  checksWithAuth(nodeAuthToken?: Secret): Checks {
    return new Checks(
      this.resolveSource(),
      nodeAuthToken ?? this.nodeAuthToken,
      this.packagePaths,
      this.registryScope,
      this.checkBase,
      this.changedFiles,
      this.nodeMaxOldSpaceMb,
    );
  }

  /**
   * Orchestrates high-performance Playwright E2E test execution.
   *
   * Includes advanced features like dependency layering, browser caching, and
   * Staytuned's "Affected Test" discovery for lightning-fast feedback loops.
   *
   * @param source - The repository source directory.
   * @param nodeAuthToken - Optional secret token for GitHub Packages npm authentication.
   * @param packagePaths - The target package path (or CSV list) relative to the source root.
   * @param testSelector - Optional selector expression (path or tag) passed to Playwright via `--`.
   * @param testScript - The npm script to invoke for testing. Defaults to 'test:e2e'.
   * @param runBuild - When true, ensures 'npm run build' completes before test execution. Highly recommended for TypeScript projects.
   * @param registryScope - The GitHub Packages organization scope (e.g. 'staytunedllp').
   * @param browsers - Comma-separated list of browsers to provision (supported: 'chromium', 'firefox', 'webkit').
   * @param runAffected - Enable intelligent test discovery to run only tests affected by your current git diff.
   * @param base - The base git ref to compare against for affected discovery (e.g. 'origin/main').
   * @param listOnly - Disables test execution and instead returns the discovered test selectors as a string.
   * @param changedFiles - Manually specify a list of changed files to use for affected discovery, bypassing git diff.
   *
   * @example
   * dagger call test-playwright --source . --package-paths "apps/web" --run-affected
   */
  @check()
  @func()
  async testPlaywright(
    @argument({
      defaultPath: ".",
      ignore: [".git", "dagger", "dist", "node_modules"],
    })
    source: Directory,
    nodeAuthToken?: Secret,
    packagePaths = ".",
    testSelector = "",
    testScript = "test:e2e",
    runBuild = true,
    registryScope = "staytunedllp",
    browsers = "chromium",
    runAffected = false,
    base = "origin/main",
    listOnly = false,
    changedFiles = "",
    skipReferenceChecks = true,
  ): Promise<string> {
    // Verify chromium-bidi using the private helper
    await this.verifyChromiumBidi(source, nodeAuthToken, packagePaths);

    return runPlaywrightTests(source, {
      nodeAuthToken,
      packagePaths,
      testSelector,
      testScript,
      runBuild,
      registryScope,
      browsers,
      runAffected,
      base,
      listOnly,
      changedFiles,
      skipReferenceChecks,
    });
  }

  /**
   * Validate that `chromium-bidi` is installed in the selected package path.
   *
   * @param source - Repository source directory that contains the package to inspect.
   * @param nodeAuthToken - Optional GitHub Packages token secret. Required only when installing private npm packages.
   * @param packagePaths - Package path or comma-separated package paths relative to the source root. The first path is used for the chromium-bidi check.
   */
  private async verifyChromiumBidi(
    source: Directory,
    nodeAuthToken?: Secret,
    packagePaths = ".",
  ): Promise<string> {
    return runNodeChecks(source, nodeAuthToken, {
      packagePaths,
      verifyChromiumBidi: true,
    });
  }

  /**
   * Retrieves an array of changed file paths using git diff.
   *
   * This is a powerful helper for automating logic based on PR changes.
   *
   * @param source - The source directory to check for changed files.
   * @param mode - The diffing strategy: 'staged' (uncommitted), 'previous' (last commit), or 'between' (custom range).
   * @param commitRange - The specific git range string (e.g. "HEAD~2..HEAD"). Required if mode is 'between'.
   *
   * @example
   * # Check for files in current PR branch
   * dagger call git-diff --source . --mode staged
   */
  @func()
  async gitDiff(
    @argument({ defaultPath: ".", ignore: ["dagger", "dist", "node_modules"] })
    source: Directory,
    mode: string = "staged",
    commitRange = "",
  ): Promise<string[]> {
    switch (mode) {
      case "staged":
        return gitDiffStaged(source);
      case "previous":
        return gitDiffPrevious(source);
      case "between":
        if (!commitRange) {
          throw new Error("commitRange is required for 'between' mode");
        }
        return gitDiffBetweenCommits(source, commitRange);
      default: {
        throw new Error("Unsupported git diff mode");
      }
    }
  }

  /**
   * Unified management of Firebase App Hosting backends.
   *
   * This function automates the creation, deployment, and deletion of App Hosting
   * backends, supporting both Personal Access Tokens and Workload Identity Federation (WIF).
   * When `buildBeforeDeploy` is enabled for deploys, it also prepares the source
   * for Vite by writing `.env.production` from the Firebase web app config and
   * running the package build before Firebase deploys the backend.
   *
   * @param action - The backend lifecycle action: 'deploy' or 'delete'.
   * @param projectId - The unique identifier of your Firebase/GCP project.
   * @param backendId - The unique identifier for this specific App Hosting backend.
   * @param source - Repository source directory (required for 'deploy' action).
   * @param rootDir - Root directory of the application inside your repository. Defaults to '.'.
   * @param appId - Associate this backend with a specific Firebase Web App ID (deploy only).
   * @param region - The GCP region to provision the backend in (e.g. 'us-central1').
   * @param gcpCredentials - Optional secret containing GCP service account JSON content.
   * @param wifProvider - Full resource name of the WIF provider (deploy only).
   * @param webappConfig - Optional secret JSON containing the full Firebase web app configuration.
   * @param extraEnv - Optional secret containing extra environment variables for the frontend build.
   * @param nodeAuthToken - Optional secret token for GitHub Packages npm authentication.
   * @param registryScope - The GitHub Packages organization scope (e.g. 'staytunedllp').
   * @param wifProvider - Full resource name of the WIF provider (deploy only).
   * @param wifServiceAccount - Email of the service account to impersonate via WIF (deploy only).
   * @param wifOidcToken - OIDC token secret required for WIF authentication in CI environments.
   * @param wifAudience - Optional specific audience for the WIF OIDC token.
   * @param buildBeforeDeploy - When true, installs dependencies, writes Vite env files, and runs the package build before deploy.
   *
   * @example
   * dagger call fb-apphosting --action deploy --source . --project-id "my-project" --backend-id "web-app"
   */
  @func()
  async fbApphosting(
    action: string,
    projectId: string,
    backendId: string,
    @argument({ defaultPath: ".", ignore: ["dagger", "dist", "node_modules"] })
    source?: Directory,
    rootDir = ".",
    appId = "",
    region = "asia-southeast1",
    gcpCredentials?: Secret,
    webappConfig?: Secret,
    extraEnv?: Secret,
    nodeAuthToken?: Secret,
    registryScope?: string,
    wifProvider = "",
    wifServiceAccount = "",
    wifOidcToken?: Secret,
    wifAudience = "",
    buildBeforeDeploy = false,
  ): Promise<string> {
    if (action === "deploy") {
      if (!source) {
        throw new Error("source is required for 'deploy' action");
      }
      if (buildBeforeDeploy) {
        return deployFirebaseApphostingPipeline(
          source,
          projectId,
          backendId,
          rootDir,
          appId,
          region,
          gcpCredentials,
          webappConfig,
          extraEnv,
          nodeAuthToken,
          registryScope,
          wifProvider,
          wifServiceAccount,
          wifOidcToken,
          wifAudience,
        );
      }
      return deployFirebaseApphostingProject(
        source,
        projectId,
        backendId,
        rootDir,
        appId,
        region,
        gcpCredentials,
        wifProvider,
        wifServiceAccount,
        wifOidcToken,
        wifAudience,
      );
    }

    if (action === "delete") {
      return deleteFirebaseApphostingBackend(
        projectId,
        backendId,
        gcpCredentials,
        wifProvider,
        wifServiceAccount,
        wifOidcToken,
        wifAudience,
      );
    }

    throw new Error("Unsupported action");
  }

  /**
   * High-level pipeline for building and deploying Firebase Web Hosting projects.
   *
   * This function provides a complete "Build once, deploy anywhere" workflow by:
   * 1. Preparing a Node workspace with all required dependencies.
   * 2. Injecting Firebase App ID and Web App Config into the frontend environment.
   * 3. Executing the frontend build (e.g. 'npm run build').
   * 4. Authenticating with GCP and deploying to Firebase Hosting.
   *
   * @param source - Repository source directory containing the Firebase project and application packages.
   * @param projectId - The target Firebase project ID.
   * @param gcpCredentials - Secret container for the GCP service account JSON key.
   * @param appId - Optional Firebase App ID to inject as NEXT_PUBLIC_FIREBASE_APP_ID or similar.
   * @param only - Optional deployment filter (e.g. 'hosting', 'functions').
   * @param frontendDir - Relative path to the frontend package directory.
   * @param backendDir - Relative path to a backend or secondary package directory to prepare.
   * @param firebaseDir - Directory containing 'firebase.json'. Defaults to the workspace root.
   * @param webappConfig - Optional secret JSON containing the full Firebase web app configuration.
   * @param extraEnv - Optional secret containing extra environment variables for the frontend build.
   * @param nodeAuthToken - Optional secret token for GitHub Packages npm authentication.
   *
   * @example
   * dagger call fb-webhosting --source . --project-id "my-project" --gcp-credentials env:GCP_KEY
   */
  @func({ cache: "never" })
  async fbWebhosting(
    @argument({ defaultPath: ".", ignore: ["dagger", "dist", "node_modules"] })
    source: Directory,
    projectId: string,
    gcpCredentials: Secret,
    appId?: string,
    only?: string,
    frontendDir?: string,
    backendDir?: string,
    firebaseDir?: string,
    webappConfig?: Secret,
    extraEnv?: Secret,
    nodeAuthToken?: Secret,
  ): Promise<string> {
    return firebaseDeployWebhostingPipeline(source, projectId, gcpCredentials, {
      appId,
      frontendDir,
      backendDir,
      firebaseDir,
      only,
      webappConfig,
      extraEnv,
      nodeAuthToken,
    });
  }

  /**
   * Production package release pipeline with deterministic PR version sync and main-only publishing.
   *
   * Use `sync-pr-version` in pull request workflows to keep package.json and package-lock.json
   * ahead of the latest base branch patch version without overwriting manual major/minor bumps.
   * When a bump is needed, the function commits and pushes the update back to the PR branch.
   *
   * Use `prepare-hourly-release` to compute the next patch version and return the manifest and
   * lockfile content to commit. It creates nothing and pushes nothing, so a dry run is genuinely
   * dry and the caller owns the pull request.
   *
   * Use `publish` on the main branch to publish the package, push the tag, and create the GitHub
   * Release. It is idempotent: an already-published version with its tag and Release is a
   * successful no-op, a missing Release is repaired without republishing, and a tag whose package
   * is absent fails loudly because that means a previous publish died midway.
   *
   * Use `github-only` where the release artifact is not a package -- a private application, or a
   * Dagger module whose public git tag is itself the distribution mechanism.
   *
   * This flow assumes branch protection requires pull requests to be up to date before merging.
   *
   * @param action - Release pipeline action to run.
   * @param source - Repository source directory to operate on.
   * @param githubToken - GitHub token with repository read access and package write access.
   * @param repoOwner - The GitHub organization or user (for example, `StaytunedLLP`).
   * @param repoName - The repository name.
   * @param registryScope - The organization scope for the npm package. Defaults to the package scope.
   * @param baseBranch - Authoritative base branch for PR version synchronization. Defaults to `main`.
   * @param packagePath - Repo-relative path to the package folder on the base branch. Defaults to the repository root.
   * @param prBranch - Pull request branch name being synchronized.
   *
   * @example
   * dagger call release-package --action sync-pr-version --source . --github-token env:GITHUB_TOKEN
   */
  @func({ cache: "never" })
  async releasePackage(
    action: string,
    @argument({ defaultPath: ".", ignore: ["dagger", "dist", "node_modules"] })
    source: Directory,
    githubToken: Secret,
    repoOwner: string,
    repoName: string,
    registryScope?: string,
    baseBranch?: string,
    packagePath?: string,
    prBranch?: string,
    npmToken?: Secret,
    dryRun = false,
    autoMerge = true,
    stalePrHours = 6,
    directPush = false,
    bump = "patch",
  ): Promise<string> {
    const supported = [
      "sync-pr-version",
      "prepare-hourly-release",
      "hourly-release",
      "publish",
      "github-only",
    ] as const;

    if (!supported.includes(action as (typeof supported)[number])) {
      throw new Error(
        `Unsupported release action "${action}". Expected one of: ${supported.join(", ")}.`,
      );
    }

    return releasePackage({
      action: action as ReleasePackageAction,
      source,
      githubToken,
      repoOwner,
      repoName,
      registryScope,
      baseBranch,
      packagePath,
      prBranch,
      npmToken,
      dryRun,
      autoMerge,
      stalePrHours,
      directPush,
      bump: parseReleaseBump(bump),
    });
  }
}
