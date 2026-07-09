import "dotenv/config";
import fs from "fs";
import path from "path";
import { Composio } from "@composio/core";
import type { AppInput } from "./prompts";
import { runResearch, type ResearchResult } from "./research";

const IS_TEST = process.argv.includes("--test");
const RESUME = process.argv.includes("--resume");
const APPS_FILE = IS_TEST ? "apps.test.json" : "apps.json";

const APPS_PATH = path.join(__dirname, APPS_FILE);
const RESULTS_PATH = path.join(__dirname, IS_TEST ? "results.test.json" : "results.json");
const SAMPLE_PATH = path.join(__dirname, "verification-sample.json");
const PATTERNS_PATH = path.join(__dirname, "patterns.json");
const GITHUB_PATH = path.join(__dirname, "composio-github.json");

const COMPOSIO_USER_ID = "research-agent@local";
const composio: Composio | null = process.env.COMPOSIO_API_KEY
  ? new Composio({ apiKey: process.env.COMPOSIO_API_KEY })
  : null;

function readJson<T>(filePath: string): T {
  return JSON.parse(fs.readFileSync(filePath, "utf-8"));
}

function writeJson(filePath: string, value: unknown) {
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2));
}

function loadApps(): AppInput[] {
  return readJson<AppInput[]>(APPS_PATH);
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function pickVerificationSample(sampleSize = 20) {
  if (!fs.existsSync(RESULTS_PATH)) {
    console.error("No results.json yet - run research first.");
    return;
  }
  const results = readJson<ResearchResult[]>(RESULTS_PATH);

  const low = results.filter((r) => r.confidence === "low");
  const high = results.filter((r) => r.confidence !== "low");

  const lowCount = Math.min(low.length, Math.ceil(sampleSize * 0.6));
  const highCount = sampleSize - lowCount;

  const shuffledHigh = [...high].sort(() => Math.random() - 0.5).slice(0, highCount);
  const sample = [...low.slice(0, lowCount), ...shuffledHigh].sort((a, b) => a.id - b.id);

  const sampleWithChecklist = sample.map((r) => ({
    id: r.id,
    name: r.name,
    agent_said: {
      access: r.access,
      auth_methods: r.auth_methods,
      has_mcp: r.has_mcp,
      has_composio_toolkit: r.has_composio_toolkit,
      composio_tool_count: r.composio_tool_count,
      buildable_verdict: r.buildable_verdict,
      evidence_url: r.evidence_url,
      confidence: r.confidence,
    },
    human_verdict: "",
    human_notes: "",
  }));

  writeJson(SAMPLE_PATH, sampleWithChecklist);
  console.log(
    `Wrote ${sampleWithChecklist.length} apps to verification-sample.json ` +
      `(${lowCount} low-confidence, ${highCount} high-confidence). ` +
      "Fill in human_verdict/human_notes by hand, then re-run patterns."
  );
}

function computePatterns() {
  if (!fs.existsSync(RESULTS_PATH)) {
    console.error("No results.json yet - run research first.");
    return;
  }
  const results = readJson<ResearchResult[]>(RESULTS_PATH);

  const byCategory: Record<string, ResearchResult[]> = {};
  for (const r of results) {
    (byCategory[r.category] ||= []).push(r);
  }

  const authCounts: Record<string, number> = {};
  const accessCounts: Record<string, number> = {};
  const verdictCounts: Record<string, number> = {};
  const blockerCounts: Record<string, number> = {};
  let mcpCount = 0;
  let composioToolkitCount = 0;

  for (const r of results) {
    for (const auth of r.auth_methods || []) {
      authCounts[auth] = (authCounts[auth] || 0) + 1;
    }
    accessCounts[r.access] = (accessCounts[r.access] || 0) + 1;
    verdictCounts[r.buildable_verdict] = (verdictCounts[r.buildable_verdict] || 0) + 1;
    if (r.blocker && r.blocker !== "none") {
      blockerCounts[r.blocker] = (blockerCounts[r.blocker] || 0) + 1;
    }
    if (r.has_mcp) mcpCount++;
    if (r.has_composio_toolkit) composioToolkitCount++;
  }

  const categoryBreakdown = Object.entries(byCategory).map(([category, items]) => {
    const gated = items.filter((i) => i.access.startsWith("gated")).length;
    const selfServe = items.filter((i) => i.access.startsWith("self-serve")).length;
    return {
      category,
      total: items.length,
      self_serve: selfServe,
      gated,
      buildable_today: items.filter((i) => i.buildable_verdict === "yes-today").length,
      with_mcp: items.filter((i) => i.has_mcp).length,
      with_composio_toolkit: items.filter((i) => i.has_composio_toolkit).length,
    };
  });

  const patterns = {
    total_apps: results.length,
    auth_method_distribution: authCounts,
    access_distribution: accessCounts,
    buildable_verdict_distribution: verdictCounts,
    top_blockers: Object.entries(blockerCounts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10),
    apps_with_existing_mcp: mcpCount,
    apps_with_existing_composio_toolkit: composioToolkitCount,
    category_breakdown: categoryBreakdown,
  };

  writeJson(PATTERNS_PATH, patterns);
  console.log("Wrote patterns.json. Summary:");
  console.log(JSON.stringify(patterns, null, 2));
}

async function connectGithub() {
  if (!composio) {
    console.error("COMPOSIO_API_KEY not set - cannot connect an account.");
    return;
  }

  console.log(`Requesting a GitHub connection for user "${COMPOSIO_USER_ID}"...`);

  try {
    const connectionRequest = await (composio as any).toolkits.authorize(
      COMPOSIO_USER_ID,
      "GITHUB"
    );

    console.log(`\nOpen this URL in your browser to authorize a GitHub account:\n  ${connectionRequest.redirectUrl}\n`);
    console.log("Waiting up to 2 minutes for you to finish authorizing...");

    const connectedAccount = await connectionRequest.waitForConnection(120_000);
    console.log(`\nConnected! Account id: ${(connectedAccount as any)?.id ?? "unknown"}`);
    console.log("You can now run `npm run github` - it will use this connected account.");
  } catch (err) {
    console.error(`\nCouldn't complete the connection: ${(err as Error).message}`);
  }
}

async function runComposioGithubCheck() {
  if (!composio) {
    console.error("COMPOSIO_API_KEY not set - cannot run the github sub-task.");
    return;
  }

  const apps = loadApps();
  const ossApps = apps.filter((a) => a.hint.includes("github.com"));

  if (ossApps.length === 0) {
    console.log(`No github.com-hinted apps found in ${APPS_FILE}.`);
    return;
  }

  const tools = await composio.tools.get(COMPOSIO_USER_ID, { toolkits: ["GITHUB"] });
  console.log(`Loaded ${tools.length} GitHub tools from Composio for ${ossApps.length} OSS apps.`);

  const output: Record<string, unknown>[] = [];
  let warnedAboutConnection = false;

  for (const app of ossApps) {
    const match = app.hint.match(/github\.com\/([\w-]+)\/([\w.-]+)/);
    if (!match) continue;
    const [, owner, repo] = match;

    try {
      const result = await composio.tools.execute("GITHUB_GET_A_REPOSITORY", {
        userId: COMPOSIO_USER_ID,
        arguments: { owner, repo },
      });
      output.push({ app: app.name, owner, repo, composio_result: result });
      console.log(`  ${app.name}: fetched repo metadata via Composio`);
    } catch (err) {
      const message = (err as Error).message;
      output.push({ app: app.name, owner, repo, error: message });
      console.warn(`  ${app.name}: Composio call failed - ${message}`);

      if (!warnedAboutConnection && /no connected account/i.test(message)) {
        warnedAboutConnection = true;
        console.warn(
          `\n  [composio] No GitHub account is connected for user "${COMPOSIO_USER_ID}" yet.\n` +
            "  Run `npm run connect-github`, authorize GitHub, then re-run `npm run github`.\n"
        );
      }
    }
    await sleep(1000);
  }

  writeJson(GITHUB_PATH, output);
  console.log(`Saved ${output.length} Composio-sourced repo records -> composio-github.json`);
}

async function main() {
  const cmd = process.argv[2] || "research";

  switch (cmd) {
    case "research": {
      const rerun = process.argv.includes("--rerun");
      await runResearch({
        appsPath: APPS_PATH,
        resultsPath: RESULTS_PATH,
        version: rerun ? "v2" : "v1",
        resume: RESUME,
      });
      break;
    }
    case "sample": {
      const n = Number(process.argv[3]) || 20;
      pickVerificationSample(n);
      break;
    }
    case "patterns":
      computePatterns();
      break;
    case "github":
      await runComposioGithubCheck();
      break;
    case "connect-github":
      await connectGithub();
      break;
    default:
      console.log("Unknown command. Use: research | sample | patterns | github | connect-github");
  }
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});