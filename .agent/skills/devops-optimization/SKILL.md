---
name: devops-optimization
description: Architect-level DevOps optimization for Daggerized workflows and ARC runners.
---

# DevOps Optimization Standard

This skill defines the high-performance standards for Daggerization, infrastructure alignment with `st-arc`, and multi-repo generalization.

## What is it?
A set of architectural patterns and procedural rules to ensure that every CI/CD pipeline built at Staytuned is ultra-fast, secure, and reusable.

## Why use it?
- **Speed**: Prevents redundant `npm install` runs and multi-gigabyte browser downloads.
- **Safety**: Ensures all high-compute tasks run in isolated ARC nodes.
- **Scalability**: Allows a single Dagger module to serve dozens of repositories with zero code changes.

## Procedure: Daggerizing a Workflow

### 1. Runner Setup (st-arc)
All Daggerized workflows **must** run on `st-arc`.

```yaml
runs-on: st-arc
```

### 2. Bootstrapping
Always include the bootstrap step to connect to the internal Dagger engine.

```yaml
- name: Bootstrap Dagger (ARC)
  uses: staytunedllp/devops/.github/actions/dagger-bootstrap@main
  with:
    namespace: dagger
    label_selector: name=dagger-engine
```

### 3. Caching Strategy (Next-Level)
Use the **Lockfile-First** pattern in TypeScript modules:

1.  **Mount NPM Cache**: `dag.cacheVolume("node-npm-cache")` mapped to `/root/.npm`.
2.  **Copy Lockfiles Only**: Copy `package.json` and `package-lock.json` into the container.
3.  **Run Install**: Execute `npm ci`. This creates a cached layer that only invalidates on dependency changes.
4.  **Copy Code**: copy the remaining code using `withDirectory(..., { exclude: ["node_modules", ...] })`.
5.  **Mount Tool Caches**: Always map tool-specific caches (e.g., Playwright: `/root/.cache/ms-playwright`).

### 4. Generalization Rules
- **No Hardcoded Scripts**: Use arguments like `testScript` (default: `test:e2e`).
- **Conditional Steps**: Use boolean flags like `runBuild` (default: `true`).
- **Scoped Authentication**: Use dynamic template strings for `.npmrc` injection based on a `registryScope` parameter.

## Examples

### Generalized Playwright Module
```typescript
@func()
async test(
  source: Directory,
  nodeAuthToken: Secret,
  testSelector: string = "",
  testScript: string = "test:e2e",
  runBuild: boolean = true
): Promise<string> {
  // 1. Setup base with volumes
  // 2. Auth & Install with lockfile-only check
  // 3. Conditional build
  // 4. Test execution
}
```

### ARC Workflow Template
```yaml
jobs:
  test:
    runs-on: st-arc
    steps:
      - uses: actions/checkout@v6
      - name: Bootstrap Dagger
        uses: staytunedllp/devops/.github/actions/dagger-bootstrap@main
      - name: Dagger Call
        uses: dagger/dagger-for-github@v8.3.0
        with:
          module: github.com/StaytunedLLP/devops/<module>@main
          args: test --source . --node-auth-token env:TOKEN
        env:
          TOKEN: ${{ secrets.GITHUB_TOKEN }}
```
