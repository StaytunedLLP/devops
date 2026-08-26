#!/usr/bin/env node

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

// Helper to run shell commands safely
function runCmd(cmd) {
  try {
    return execSync(cmd, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  } catch (err) {
    return null;
  }
}

const args = process.argv.slice(2);
const shouldWait = args.includes('--wait');
const cleanArgs = args.filter(a => a !== '--wait');

let prNumber = cleanArgs[0];
if (!prNumber) {
  prNumber = runCmd('gh pr view --json number -q .number');
}

if (!prNumber) {
  console.error("❌ Error: Could not determine PR number. Please pass a PR number as an argument.");
  process.exit(1);
}

const pollIntervalMs = 20000; // 20 seconds
const maxPolls = 30; // 10 minutes max

async function run() {
  let pollCount = 0;
  while (true) {
    console.log(`🔍 Fetching GHA Checks for PR #${prNumber}...`);
    const checksJson = runCmd(`gh pr checks ${prNumber} --json name,state,event,link`);
    if (!checksJson) {
      console.error(`❌ Error: Failed to fetch checks for PR #${prNumber}.`);
      process.exit(1);
    }

    const checks = JSON.parse(checksJson);
    const failures = checks.filter(c => c.state === 'FAILING' || c.state === 'FAILURE');
    const pending = checks.filter(c => c.state === 'PENDING');

    console.log(`✅ Passed/Skipped: ${checks.length - failures.length - pending.length}`);
    console.log(`⏳ Pending: ${pending.length}`);
    console.log(`❌ Failed: ${failures.length}`);

    // If there are failures, or all checks completed, or we are not waiting
    if (failures.length > 0 || pending.length === 0 || !shouldWait) {
      const report = {
        prNumber: parseInt(prNumber, 10),
        timestamp: new Date().toISOString(),
        status: failures.length > 0 ? 'FAILED' : pending.length > 0 ? 'PENDING' : 'SUCCESS',
        failures: [],
      };

      if (failures.length > 0) {
        console.log("\n🚨 Analyzing failures...");
        for (const fail of failures) {
          console.log(`- Job: ${fail.name}`);
          console.log(`  Link: ${fail.link}`);
          
          const runMatch = fail.link.match(/\/runs\/(\d+)/);
          if (runMatch) {
            const runId = runMatch[1];
            console.log(`  Run ID: ${runId}. Fetching failed logs...`);
            const logs = runCmd(`gh run view ${runId} --log-failed`);
            if (logs) {
              report.failures.push({
                jobName: fail.name,
                link: fail.link,
                runId: runId,
                logs: logs
              });
            } else {
              report.failures.push({
                jobName: fail.name,
                link: fail.link,
                runId: runId,
                logs: "Could not fetch failed logs."
              });
            }
          } else {
            report.failures.push({
              jobName: fail.name,
              link: fail.link,
              logs: "No run ID found in link."
            });
          }
        }
      }

      const reportsDir = path.resolve(process.cwd(), '.artifacts/pr-monitor');
      fs.mkdirSync(reportsDir, { recursive: true });
      const reportPath = path.join(reportsDir, `pr-${prNumber}-status.json`);
      fs.writeFileSync(reportPath, JSON.stringify(report, null, 2), 'utf8');
      console.log(`\n📝 Status report written to ${reportPath}`);

      if (failures.length > 0) {
        process.exit(1);
      } else if (pending.length > 0) {
        process.exit(2); // Still pending but stopped waiting (or timeout)
      } else {
        process.exit(0);
      }
    }

    pollCount++;
    if (pollCount >= maxPolls) {
      console.log("⏳ Timeout reached waiting for checks to complete.");
      process.exit(2);
    }

    console.log(`⏳ Checks are still pending. Waiting ${pollIntervalMs / 1000}s before next check...`);
    await new Promise(resolve => setTimeout(resolve, pollIntervalMs));
  }
}

run();
