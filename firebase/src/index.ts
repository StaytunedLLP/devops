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

type FirebaseWebAppConfig = {
  apiKey?: string;
  authDomain?: string;
  projectId?: string;
  storageBucket?: string;
  messagingSenderId?: string;
  appId?: string;
  measurementId?: string;
};

function formatEnvValue(value: string): string {
  if (/^[A-Za-z0-9_./:@-]+$/.test(value)) {
    return value;
  }
  return JSON.stringify(value);
}

function lenientParse(input: string): any {
  const trimmed = input.trim();
  if (!trimmed) return {};

  try {
    return JSON.parse(trimmed);
  } catch {
    // Attempt to fix common JS literal issues:
    // 1. Wrap unquoted keys in double quotes
    // 2. Replace single quotes with double quotes
    // 3. Remove trailing commas
    const fixed = trimmed
      .replace(/([{,]\s*)([a-zA-Z0-9_]+)\s*:/g, '$1"$2":')
      .replace(/'/g, '"')
      .replace(/,\s*([}\]])/g, "$1");

    try {
      return JSON.parse(fixed);
    } catch (err: any) {
      throw new Error(
        `Failed to parse webappConfig. Please ensure it is a valid JSON or JS object literal. ${err.message}`,
      );
    }
  }
}

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
      let builder = nodeBase().withWorkdir("/src");

      // Set explicit env variables
      builder = builder.withEnvVariable("VITE_FIREBASE_PROJECT_ID", projectId);
      if (appId) {
        builder = builder.withEnvVariable("VITE_FIREBASE_APP_ID", appId);
      }

      // Mount existing .env if present
      const frontendEntries = await configuredSrc.directory(frontendDir).entries();
      if (frontendEntries.includes(".env")) {
        builder = builder.withFile(".env", configuredSrc.file(`${frontendDir}/.env`));
      } else {
        builder = builder.withNewFile(".env", "");
      }

      if (webappConfig) {
        builder = builder.withSecretVariable("WEBAPP_CONFIG_SECRET", webappConfig);
      }
      if (extraEnv) {
        builder = builder.withSecretVariable("EXTRA_ENV_SECRET", extraEnv);
      }

      // We run a small node script within the container to safely parse secrets and append them
      // This prevents the plaintext values from leaking into the Dagger pipeline logs.
      const script = `
        const fs = require('fs');

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

            try {
              return JSON.parse(fixed);
            } catch (err) {
              console.error("Failed to parse webappConfig:", err.message);
              process.exit(1);
            }
          }
        }

        let envContent = fs.readFileSync('.env', 'utf-8');
        // Ensure it ends with a newline if it has content
        if (envContent.length > 0 && !envContent.endsWith('\\n')) {
          envContent += '\\n';
        }

        const envEntries = {
          VITE_FIREBASE_PROJECT_ID: process.env.VITE_FIREBASE_PROJECT_ID,
        };

        if (process.env.VITE_FIREBASE_APP_ID) {
          envEntries.VITE_FIREBASE_APP_ID = process.env.VITE_FIREBASE_APP_ID;
        }

        if (process.env.WEBAPP_CONFIG_SECRET) {
          envEntries.VITE_FIREBASE_WEBAPP_CONFIG = process.env.WEBAPP_CONFIG_SECRET;
          const parsed = lenientParse(process.env.WEBAPP_CONFIG_SECRET);

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

        const generatedEnvLines = Object.entries(envEntries).map(
          ([key, value]) => key + '=' + formatEnvValue(value)
        );

        const lines = [
          envContent.trimEnd(),
          ...generatedEnvLines,
        ];

        if (process.env.EXTRA_ENV_SECRET) {
          lines.push(process.env.EXTRA_ENV_SECRET.trim());
        }

        const finalEnvContent = lines.filter(Boolean).length > 0
          ? lines.filter(Boolean).join("\\n") + "\\n"
          : "";

        fs.writeFileSync('.env', finalEnvContent);
      `;

      builder = builder.withExec(["node", "-e", script]);

      const secureEnvFile = builder.file(".env");
      configuredSrc = configuredSrc.withFile(`${frontendDir}/.env`, secureEnvFile);
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
