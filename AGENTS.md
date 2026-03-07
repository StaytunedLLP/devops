# DevOps Agent Guidelines (Root Workspace)

This repository is the central hub for DevOps automation, Dagger modules, and CI/CD workflows at Staytuned. As the DevOps Agent, you are responsible for maintaining high-performance, secure, and generalized automation.

## Core Principles

1.  **Performance (Next-Level Caching)**: Workflows must be ultra-fast. Use Dagger's layer caching and volume caching effectively.
2.  **Infrastructure Security**: All Dagger operations must run on `st-arc` (Action Runner Controller) located in our private infrastructure.
3.  **Generalization**: Dagger modules should be "Multi-Repo Ready". Avoid hardcoding repository-specific paths, scripts, or build flags.

---

## Mandatory Runner Configuration

Every GitHub Action workflow that utilizes Dagger **MUST** follow this template:

### 1. Runner Requirement
```yaml
jobs:
  job_name:
    runs-on: st-arc # Mandatory for Dagger
```

### 2. Dagger Bootstrapping
Before any Dagger call, you must bootstrap the engine on the ARC node:
```yaml
      - name: Bootstrap Dagger (ARC)
        uses: staytunedllp/devops/.github/actions/dagger-bootstrap@main
        with:
          namespace: dagger
          label_selector: name=dagger-engine
          prefer_same_node: "true"
```

---

## Dagger Module Standards (TypeScript)

When authoring Dagger modules (e.g., in `daggerverse/`), follow these optimization patterns.

### 1. Lockfile-First Caching (Layer Isolation)
**Mandatory**: Do not copy the entire source directory before installing dependencies. This ensures that changes to application code do not invalidate the heavy `npm install` layer.

```typescript
    // 1. Setup Base with common mounts
    const base = dag.container()
      .from("node:24")
      .withMountedCache("/root/.npm", dag.cacheVolume("node-npm-cache"))

    // 2. Copy ONLY lockfiles
    let setup = base.withFile("package.json", source.file("package.json"))
    try {
        setup = setup.withFile("package-lock.json", source.file("package-lock.json"))
    } catch { /* fallback */ }

    // 3. Install (This layer is now cached strictly by lockfile signature)
    const installed = setup.withExec(["npm", "ci"])

    // 4. Finally, copy rest of source
    const fullSource = installed.withDirectory(".", source, {
      exclude: ["node_modules", "dist", ".git", "dagger"]
    })
```

### 2. Binary & Tool Caching
Always mount a `cacheVolume` for heavy binaries or tool-specific caches (e.g., Playwright browsers, Cypress, Go build cache).
- Playwright: `/root/.cache/ms-playwright`
- NPM: `/root/.npm`

### 3. Generalization Pattern
Modules must support multiple repositories. Use default parameters that satisfy common cases but allow overrides.
- `testScript`: default `"test:e2e"`
- `runBuild`: default `true`
- `registryScope`: default `"staytunedllp"`

---

## Workflow Implementation Standard

Use `dagger/dagger-for-github` for consistency. Always pass secrets as environment variables and map them to Dagger parameters.

```yaml
      - name: Dagger Call
        uses: dagger/dagger-for-github@v8.3.0
        with:
          version: "0.20.0"
          verb: call
          module: github.com/StaytunedLLP/devops/<module_path>@main
          args: <function_name> --source=. --auth-token=env:AUTH_TOKEN
        env:
          AUTH_TOKEN: ${{ secrets.GITHUB_TOKEN }}
```

---

## Project Skills

Proactive research and specialized task execution guidelines are stored in `.agent/skills/`.
- **Location**: `.agent/skills/`
- **Standard**: Every skill must have a `SKILL.md` with "What", "Why", and "How" sections.
- **Reference**: Refer to `dev-build-validate` for monorepo health checks.
