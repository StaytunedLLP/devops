import { dag, Container, Directory, Secret, object, func } from "@dagger.io/dagger"

@object()
export class Playwright {
    /**
     * Run Playwright E2E tests for the provided project source.
     *
     * @param source Project source directory containing package.json and Playwright tests.
     * @param nodeAuthToken GitHub NPM token for authenticating with @staytunedllp registry.
     * @param testSelector Optional string to pass to test script (selector or path).
     * @param testScript Name of the npm script to run for testing (default: test:e2e).
     * @param runBuild Whether to run 'npm run build' before testing (default: true).
     * @param registryScope GitHub Packages registry owner scope (default: staytunedllp).
     * @returns Standard output from Playwright tests.
     */
    @func()
    async test(
        source: Directory,
        nodeAuthToken: Secret,
        testSelector: string = "",
        testScript: string = "test:e2e",
        runBuild: boolean = true,
        registryScope: string = "staytunedllp"
    ): Promise<string> {
        // -------------------------------------------------------------------------
        // 1. Volumes for Caching
        // -------------------------------------------------------------------------
        // Caching npm packages to save bandwidth and install time.
        const nodeCache = dag.cacheVolume("st-node24-npm")

        // Caching playwright browsers to avoid re-downloading them every time.
        const playwrightCache = dag.cacheVolume("st-playwright-browsers")

        // -------------------------------------------------------------------------
        // 2. Base Container Setup
        // -------------------------------------------------------------------------
        const base = dag
            .container()
            .from("node:24")
            .withWorkdir("/src")
            .withMountedCache("/root/.npm", nodeCache)
            .withMountedCache("/root/.cache/ms-playwright", playwrightCache)
            .withSecretVariable("NODE_AUTH_TOKEN", nodeAuthToken)
            .withEnvVariable("HUSKY", "0")

        // -------------------------------------------------------------------------
        // 3. GitHub Packages Authentication & Dependency Installation (Cached)
        // -------------------------------------------------------------------------
        // Filter source to only include package definitions to preserve cache invalidation granularity
        const packageDefinitions = dag.directory().withDirectory("/", source, {
            include: [
                "**/package.json",
                "**/package-lock.json",
                "**/package-lock.yaml",
                "**/.npmrc",
                "**/yarn.lock",
                "**/pnpm-lock.yaml"
            ]
        })

        // 1. Copy package definitions
        // 2. Clear all potentially overriding local .npmrc files
        // 3. Inject GLOBAL auth into /root/.npmrc so it's available for all sub-installs
        // 4. Run install in every directory containing a lockfile (Failing on any error)
        const installed = base
            .withDirectory(".", packageDefinitions)
            .withExec([
                "sh", "-c",
                "find . -name '.npmrc' -delete"
            ])
            .withExec([
                "sh", "-c",
                `echo "@${registryScope}:registry=https://npm.pkg.github.com" > /root/.npmrc && ` +
                `echo "//npm.pkg.github.com/:_authToken=\${NODE_AUTH_TOKEN}" >> /root/.npmrc`
            ])
            .withExec([
                "sh", "-c",
                "find . -name 'package-lock.json' -not -path '*/node_modules/*' | while read f; do " +
                "dir=$(dirname \"$f\"); echo \"Installing in $dir\"; " +
                "(cd \"$dir\" && npm ci --legacy-peer-deps) || exit 1; done"
            ])
            .withEnvVariable("PATH", "/src/node_modules/.bin:${PATH}", { expand: true })

        // -------------------------------------------------------------------------
        // 4. Copy Rest of Source
        // -------------------------------------------------------------------------
        const fullSource = installed.withDirectory(".", source, {
            exclude: ["node_modules", "dist", ".git", "dagger"]
        })

        // -------------------------------------------------------------------------
        // 5. Optional Build Step
        // -------------------------------------------------------------------------
        let built = fullSource;
        if (runBuild) {
            built = fullSource.withExec(["npm", "run", "build"])
        }

        // -------------------------------------------------------------------------
        // 6. Playwright Browser & OS Dependency Installation
        // -------------------------------------------------------------------------
        const bws = built.withExec(["sh", "-c", "npx playwright install --with-deps"])

        // -------------------------------------------------------------------------
        // 7. Dynamic Test Execution
        // -------------------------------------------------------------------------
        let cmd = ["npm", "run", testScript]
        if (testSelector) {
            cmd.push("--", testSelector)
        }

        const testOutput = await bws.withExec(cmd).stdout()

        return testOutput
    }
}
