/**
 * A module for building and deploying projects to Firebase.
 *
 * This module provides a reusable pipeline to automate the deployment process of Firebase applications.
 * It handles dependency installation, building (with VITE environment injection), and deployment
 * using Google Cloud Workload Identity Federation for secure authentication.
 */
import { Directory, object, func, Secret } from "@dagger.io/dagger";
import { installDeps } from "./install.js";
import { build } from "./build.js";
import { deploy } from "./deploy.js";
import { nodeBase } from "./firebase.js";

@object()
export class Firebase {
  /**
   * Main reusable pipeline to build and deploy Firebase applications.
   *
   * @param {Directory} source - The source directory containing the project files.
   * @param {string} projectId - The Google Cloud Project ID for Firebase deployment.
   * @param {Secret} gcpCredentials - The JSON credentials secret (Service Account Key or WIF config).
   * @param {string} [appId] - The Firebase App ID (optional, used for VITE environment injection).
   * @param {string} [only] - Firebase deploy filter (e.g., 'hosting', 'functions').
   * @param {string} [frontendDir] - Path to the frontend directory relative to the source.
   * @param {string} [backendDir] - Path to the backend directory relative to the source.
   * @param {string} [firebaseDir] - Directory containing firebase.json relative to the source.
   * @param {Secret} [webappConfig] - Optional Firebase Web App config JSON secret for granular env injection.
   * @param {Secret} [extraEnv] - Optional secret containing additional environment variables to append to .env.
   * @returns {Promise<string>} A promise that resolves to the standard output of the deployment command.
   */
  // Deploy has side effects and must run every time.
  @func({ cache: "never" })
  async firebaseDeploy(
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
  ): Promise<string> {
    // 1. Install dependencies
    const installedSrc = await installDeps(source, frontendDir, backendDir);

    // 2. Inject VITE parameters into Web App's .env file
    let configuredSrc = installedSrc;
    if (frontendDir) {
      const frontendEntries = await configuredSrc.directory(frontendDir).entries();

      let envBuilder = nodeBase()
        .withDirectory("/src", configuredSrc)
        .withWorkdir(`/src/${frontendDir}`)
        .withEnvVariable("VITE_FIREBASE_PROJECT_ID", projectId);

      if (appId) {
        envBuilder = envBuilder.withEnvVariable("VITE_FIREBASE_APP_ID", appId);
      }
      if (webappConfig) {
        envBuilder = envBuilder.withSecretVariable(
          "VITE_FIREBASE_WEBAPP_CONFIG",
          webappConfig,
        );
      }
      if (extraEnv) {
        envBuilder = envBuilder.withSecretVariable("EXTRA_ENV_CONTENT", extraEnv);
      }
      if (frontendEntries.includes(".env")) {
        envBuilder = envBuilder.withEnvVariable("HAS_EXISTING_ENV", "true");
      }

      envBuilder = envBuilder.withExec([
        "node",
        "-e",
        `
const fs = require("node:fs");

function formatEnvValue(value) {
  if (/^[A-Za-z0-9_./:@-]+$/.test(value)) {
    return value;
  }
  return JSON.stringify(value);
}

function lenientParse(input) {
  const trimmed = input.trim();
  if (!trimmed) return {};

  try {
    return JSON.parse(trimmed);
  } catch {
    const fixed = trimmed
      .replace(/([{,]\\s*)([a-zA-Z0-9_]+)\\s*:/g, '$1"$2":')
      .replace(/'/g, '"')
      .replace(/,\\s*([}\\]])/g, "$1");
    return JSON.parse(fixed);
  }
}

const envEntries = {
  VITE_FIREBASE_PROJECT_ID: process.env.VITE_FIREBASE_PROJECT_ID,
};

if (process.env.VITE_FIREBASE_APP_ID) {
  envEntries.VITE_FIREBASE_APP_ID = process.env.VITE_FIREBASE_APP_ID;
}

if (process.env.VITE_FIREBASE_WEBAPP_CONFIG) {
  envEntries.VITE_FIREBASE_WEBAPP_CONFIG = process.env.VITE_FIREBASE_WEBAPP_CONFIG;
  const parsed = lenientParse(process.env.VITE_FIREBASE_WEBAPP_CONFIG);
  const mapping = [
    ["apiKey", "VITE_FIREBASE_API_KEY"],
    ["authDomain", "VITE_FIREBASE_AUTH_DOMAIN"],
    ["projectId", "VITE_FIREBASE_PROJECT_ID"],
    ["storageBucket", "VITE_FIREBASE_STORAGE_BUCKET"],
    ["messagingSenderId", "VITE_FIREBASE_MESSAGING_SENDER_ID"],
    ["appId", "VITE_FIREBASE_APP_ID"],
    ["measurementId", "VITE_FIREBASE_MEASUREMENT_ID"],
  ];
  for (const [configKey, envKey] of mapping) {
    const value = parsed[configKey];
    if (typeof value === "string" && value.trim().length > 0) {
      envEntries[envKey] = value;
    }
  }
}

const existingEnvContent = process.env.HAS_EXISTING_ENV === "true"
  ? fs.readFileSync(".env", "utf8").trimEnd()
  : "";
const generatedEnvLines = Object.entries(envEntries).map(
  ([key, value]) => \`\${key}=\${formatEnvValue(value)}\`,
);
const extraEnvContent = (process.env.EXTRA_ENV_CONTENT ?? "").trim();
const lines = [existingEnvContent, ...generatedEnvLines, extraEnvContent].filter(Boolean);
const envContent = lines.length > 0 ? \`\${lines.join("\\n")}\\n\` : "";
fs.writeFileSync(".env", envContent);
`,
      ]);

      configuredSrc = envBuilder.directory("/src");
    }

    // 3. Build web app and functions
    const builtSrc = await build(configuredSrc, frontendDir, backendDir);

    // 4. Deploy to Firebase
    const deployC = await deploy(
      builtSrc,
      projectId,
      gcpCredentials,
      only,
      firebaseDir,
    );

    return deployC.stdout();
  }
}
