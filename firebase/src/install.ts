import { Directory, Container } from "@dagger.io/dagger";
import { nodeBase } from "./firebase.js";

/**
 * Installs dependencies in the frontend and/or backend directories using 'npm ci' with caching.
 *
 * @param {Directory} source - The source directory containing the project.
 * @param {string} [frontendDir] - Optional path to the frontend directory relative to /src.
 * @param {string} [backendDir] - Optional path to the backend directory relative to /src.
 * @returns {Promise<Directory>} The directory with dependencies installed.
 */
export async function installDeps(
  source: Directory,
  frontendDir?: string,
  backendDir?: string,
): Promise<Directory> {
  let container = nodeBase();

  /**
   * Internal helper to perform a cache-optimized install.
   * Copies only lockfiles first to ensure code changes don't invalidate npm ci cache.
   */
  async function installWithCache(
    base: Container,
    dir: string,
  ): Promise<Container> {
    const dirRef = source.directory(dir);
    const entries = await dirRef.entries();

    // Check if package.json exists
    if (!entries.includes("package.json")) {
      console.log(`Skipping install in ${dir}: package.json not found.`);
      return base.withDirectory(`/src/${dir}`, dirRef);
    }

    let ctr = base
      .withWorkdir(`/src/${dir}`)
      .withFile("package.json", dirRef.file("package.json"));

    // package-lock is required for npm ci, but we can fallback to npm install if missing
    const hasLock = entries.includes("package-lock.json");
    if (hasLock) {
      ctr = ctr.withFile("package-lock.json", dirRef.file("package-lock.json"));
    }

    const installCmd = hasLock
      ? ["npm", "ci", "--legacy-peer-deps"]
      : ["npm", "install", "--legacy-peer-deps"];

    return ctr
      .withExec(installCmd)
      .withDirectory(".", dirRef);
  }

  if (frontendDir) {
    container = await installWithCache(container, frontendDir);
  }

  if (backendDir) {
    container = await installWithCache(container, backendDir);
  }

  // FINAL FIX: Merge the entire source into /src.
  // This ensures root files like firebase.json and .firebaserc are present.
  // Since this happens AFTER the exec calls, code changes won't invalidate the npm ci cache.
  return container.withDirectory("/src", source).directory("/src");
}
