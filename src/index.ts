// index.ts
// Main entry point for the research agent.
//
// Usage:
//   pnpm research            -> runs the full 100-app research pass (v1)
//   pnpm research:test       -> runs on just the 5-app apps.test.json subset (quick sanity check)
//   pnpm research --rerun    -> re-runs (v2), e.g. after fixing the prompt
//   pnpm research --resume   -> re-runs, but SKIPS apps that already have a
//                               successful (non-error) result in results.json.
//                               Use this after hitting a daily token cap (TPD)
//                               partway through — it won't re-spend quota on
//                               apps that already finished, only retries the
//                               ones that failed (including ones that hit the
//                               cap). Can combine with --rerun.
//   pnpm sample               -> picks a verification sample from the latest results
//   pnpm patterns             -> computes pattern/cluster analysis from results.json
//   pnpm connect-github      -> ONE-TIME: authorize a GitHub account with Composio
//                               (required before `pnpm github` will work — Composio
//                               needs a Connected Account even for public repo reads)
//   pnpm github               -> runs the Composio GitHub sub-task on OSS apps
//   pnpm report                -> generates report.html (see report.ts)
//
// Composio is now wired into TWO places:
//   1. checkComposioToolkit() — called once per app during the main research
//      loop. It queries the REAL Composio SDK (composio.tools.get) to see if
//      a toolkit already exists for that app, and feeds that verified fact
//      into the research prompt (see prompts.ts). This is ground truth, not
//      a model guess — after the model responds, we overwrite
//      has_composio_toolkit / composio_tool_count / composio_slug_tried with
//      the real values so the model can't quietly contradict them.
//   2. runComposioGithubCheck() — the original, separate sub-task that pulls
//      live GitHub repo metadata via composio.tools.execute() for
//      open-source apps in the list. Unchanged, still its own `pnpm github`
//      command, still clearly labeled as a distinct proof-of-use of the SDK.

import "dotenv/config";
import fs from "fs";
import path from "path";
import Groq from "groq-sdk";
import { Composio } from "@composio/core";
import {
  buildResearchPromptWithContext,
  AppInput,
  ComposioCheckResult,
} from "./prompts";

const IS_TEST = process.argv.includes("--test");
const RESUME = process.argv.includes("--resume");
const APPS_FILE = IS_TEST ? "apps.test.json" : "apps.json";
const APPS_PATH = path.join(__dirname, APPS_FILE);
const RESULTS_PATH = path.join(__dirname, IS_TEST ? "results.test.json" : "results.json");
const SAMPLE_PATH = path.join(__dirname, "verification-sample.json");
const PATTERNS_PATH = path.join(__dirname, "patterns.json");
const GITHUB_PATH = path.join(__dirname, "composio-github.json");

// We no longer use groq/compound's built-in search — it stuffs whatever it
// scrapes into its own internal context with no size limit we control, which
// is what caused the 413 "request too large" errors on heavy docs pages like
// Salesforce's. Instead we fetch pages ourselves (see fetchDocsText below),
// truncate them to a safe size, and hand that bounded text to a plain model.
const MODEL = "llama-3.3-70b-versatile";

const MAX_RETRIES = 4;
const TPM_LIMIT = 12000; // Groq free-tier TPM cap for llama-3.3-70b-versatile
const TPM_SAFETY_MARGIN = 0.8;
const ESTIMATED_TOKENS_PER_CALL = 2200; // much smaller now that we control page-text size
const MAX_PAGE_CHARS = 6000; // ~1500 tokens of page text, keeps requests small and predictable
const FETCH_TIMEOUT_MS = 8000;

const COMPOSIO_USER_ID = "research-agent@local";
const COMPOSIO_TIMEOUT_MS = 8000;
const COMPOSIO_CALL_GAP_MS = 350; // stay well under the 60 req/min free-tier cap

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

// Composio is optional — only instantiate it if a key is actually configured,
// so `pnpm patterns` / `pnpm sample` etc. still work fine without one, and so
// a missing key degrades gracefully (composio field just comes back null)
// instead of crashing the whole research pass.
const composio: Composio | null = process.env.COMPOSIO_API_KEY
  ? new Composio({ apiKey: process.env.COMPOSIO_API_KEY })
  : null;

if (!composio) {
  console.warn(
    "  [composio] COMPOSIO_API_KEY not set — skipping toolkit verification and github sub-task."
  );
}

// ---------- token-aware rate limiter ----------
// Tracks actual token usage (from each response's `usage` field) in a
// rolling 60s window, and waits before the NEXT call if we're close to
// the TPM cap — instead of guessing a fixed delay and hoping for the best.

class TokenBucketLimiter {
  private usageLog: { timestamp: number; tokens: number }[] = [];

  private pruneOld() {
    const cutoff = Date.now() - 60_000;
    this.usageLog = this.usageLog.filter((u) => u.timestamp > cutoff);
  }

  private currentUsage(): number {
    this.pruneOld();
    return this.usageLog.reduce((sum, u) => sum + u.tokens, 0);
  }

  async waitForCapacity(estimatedTokens: number) {
    const cap = TPM_LIMIT * TPM_SAFETY_MARGIN;
    while (this.currentUsage() + estimatedTokens > cap) {
      this.pruneOld();
      const oldest = this.usageLog[0];
      const waitMs = oldest ? Math.max(1000, 60_000 - (Date.now() - oldest.timestamp)) : 2000;
      console.log(
        `  [rate-limit guard] ${Math.round(this.currentUsage())}/${Math.round(
          cap
        )} TPM used, waiting ${(waitMs / 1000).toFixed(1)}s before next call...`
      );
      await sleep(waitMs);
    }
  }

  record(tokens: number) {
    this.usageLog.push({ timestamp: Date.now(), tokens });
  }
}

const limiter = new TokenBucketLimiter();

// Parses Groq's "Please try again in 3.562s" (per-minute limit) or
// "Please try again in 12m55.008s" (per-day limit) out of a
// rate_limit_exceeded error message, so we can back off for exactly as
// long as it tells us to instead of a blind fixed delay.
function parseRetryAfterMs(err: unknown): number | null {
  const message = (err as any)?.message ?? String(err);
  const match = message.match(/try again in (?:(\d+)m)?([\d.]+)s/i);
  if (!match) return null;
  const mins = match[1] ? parseInt(match[1], 10) : 0;
  const secs = parseFloat(match[2]);
  return Math.ceil((mins * 60 + secs) * 1000) + 500; // small buffer
}

// Groq's daily token cap (TPD) behaves completely differently from the
// per-minute cap: it's a hard wall that doesn't clear for MINUTES, not
// milliseconds. Treating it like a normal 429 (short exponential backoff,
// burn through MAX_RETRIES in a few seconds) just fails every remaining app
// for no reason. We detect it specifically so we can do ONE long wait instead.
function isDailyTokenLimit(err: unknown): boolean {
  const message = (err as any)?.message ?? String(err);
  return /tokens per day|\(TPD\)/i.test(message);
}

// Sanity cap so a mis-parsed wait time (or a genuinely exhausted day) can't
// make the process sleep for hours unattended. If we still can't get through
// after this many long waits, we give up on the app and move on rather than
// blocking the whole pipeline indefinitely.
const MAX_TPD_WAIT_MS = 20 * 60 * 1000; // 20 minutes per wait, as a ceiling
const MAX_TPD_RETRIES = 4; // separate budget from the normal MAX_RETRIES

// ---------- types ----------

interface ResearchResult {
  id: number;
  name: string;
  category: string;
  one_liner: string;
  auth_methods: string[];
  access: string;
  api_surface: { type: string; breadth: string };
  has_mcp: boolean;
  mcp_source: string;
  buildable_verdict: string;
  blocker: string;
  evidence_url: string;
  confidence: string;
  notes: string;
  // Real, verified Composio signal (not model-guessed) — see checkComposioToolkit().
  has_composio_toolkit: boolean;
  composio_tool_count: number;
  composio_slug_tried: string;
  _tools_used?: unknown;
  _fetched_url?: string | null;
  _fetch_ok?: boolean;
  _error?: string;
  _version?: "v1" | "v2";
}

// ---------- helpers ----------

function loadApps(): AppInput[] {
  return JSON.parse(fs.readFileSync(APPS_PATH, "utf-8"));
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function stripFences(text: string): string {
  return text.replace(/```json/gi, "").replace(/```/g, "").trim();
}

// Turns "GoHighLevel" -> "GOHIGHLEVEL", "Zoho CRM" -> "ZOHO_CRM", etc.
// This is a BEST-EFFORT guess at a Composio toolkit slug — Composio's real
// slugs don't always match an app's display name (abbreviations, merged
// words, etc.), so a "not found" result is a hint, not proof the toolkit
// doesn't exist. See buildComposioBlock() in prompts.ts for how we phrase
// that caveat to the model.
function guessComposioSlug(appName: string): string {
  return appName
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms)
    ),
  ]);
}

// Queries the REAL Composio SDK to check whether a toolkit already exists
// for this app. Returns null if Composio isn't configured at all (so the
// rest of the pipeline can distinguish "not checked" from "checked, not found").
async function checkComposioToolkit(app: AppInput): Promise<ComposioCheckResult | null> {
  if (!composio) return null;

  const slug = guessComposioSlug(app.name);

  try {
    const tools = await withTimeout(
      composio.tools.get(COMPOSIO_USER_ID, { toolkits: [slug] }),
      COMPOSIO_TIMEOUT_MS
    );
    const toolList: any[] = Array.isArray(tools) ? tools : [];
    return {
      slugTried: slug,
      exists: toolList.length > 0,
      toolCount: toolList.length,
      sampleTools: toolList
        .slice(0, 5)
        .map((t) => t?.function?.name ?? t?.slug ?? t?.name ?? "unknown"),
    };
  } catch (err) {
    // Includes "unknown toolkit" errors (slug guess was wrong) as well as
    // real network/timeout failures — we don't try to distinguish here,
    // we just tell the model the check errored and to treat it as unknown.
    return {
      slugTried: slug,
      exists: false,
      toolCount: 0,
      sampleTools: [],
      error: (err as Error).message,
    };
  }
}

// Pulls the first URL-like token out of a hint like "twenty.com (open-source CRM)"
// or "docs.github.com/rest", and normalizes it to a fetchable https:// URL.
// Returns null if nothing URL-shaped is found (e.g. "paygent (NMI-powered)").
function parseUrlFromHint(hint: string): string | null {
  const firstToken = hint.trim().split(/\s+/)[0];
  const looksLikeUrl = /^[\w.-]+\.[a-z]{2,}(\/.*)?$/i.test(firstToken);
  if (!looksLikeUrl) return null;
  return firstToken.startsWith("http") ? firstToken : `https://${firstToken}`;
}

// Strips HTML down to roughly-readable text: drop script/style, remove tags,
// collapse whitespace. Not a real parser, but good enough for feeding an LLM.
function htmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

// Fetches a docs/homepage URL ourselves so WE control how much text goes
// into the model's context, instead of letting Groq's compound tool scrape
// an unbounded amount internally (which is what caused the 413 errors).
async function fetchDocsText(
  app: AppInput
): Promise<{ url: string | null; text: string | null }> {
  const url = parseUrlFromHint(app.hint);
  if (!url) return { url: null, text: null };

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { "User-Agent": "Mozilla/5.0 (research-agent; educational assignment)" },
    });
    clearTimeout(timeout);

    if (!res.ok) return { url, text: null };

    const html = await res.text();
    const text = htmlToText(html).slice(0, MAX_PAGE_CHARS);
    return { url, text: text.length > 100 ? text : null };
  } catch {
    return { url, text: null };
  }
}

async function researchOneApp(app: AppInput, version: "v1" | "v2"): Promise<ResearchResult> {
  // Fetch the page ONCE per app, outside the retry loop — no point re-fetching
  // on every retry, and it keeps our own request size bounded and predictable.
  const { url: fetchedUrl, text: pageText } = await fetchDocsText(app);

  // Real Composio toolkit check, also once per app (not per retry).
  const composioInfo = await checkComposioToolkit(app);
  if (composio) await sleep(COMPOSIO_CALL_GAP_MS); // stay under the free-tier rate limit

  const prompt = buildResearchPromptWithContext(app, pageText, fetchedUrl, composioInfo);

  let tpdRetries = 0;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      // Wait until we have token headroom before even attempting the call.
      await limiter.waitForCapacity(ESTIMATED_TOKENS_PER_CALL);

      const completion = await groq.chat.completions.create({
        model: MODEL,
        messages: [{ role: "user", content: prompt }],
      });

      // Record REAL usage (not the estimate) so the limiter stays accurate.
      const totalTokens = (completion as any)?.usage?.total_tokens ?? ESTIMATED_TOKENS_PER_CALL;
      limiter.record(totalTokens);

      const raw = completion.choices[0]?.message?.content ?? "";
      const parsed = JSON.parse(stripFences(raw));

      return {
        ...parsed,
        // Overwrite with the REAL Composio signal so the model can never
        // quietly contradict verified ground truth in these three fields.
        has_composio_toolkit: composioInfo?.exists ?? false,
        composio_tool_count: composioInfo?.toolCount ?? 0,
        composio_slug_tried: composioInfo?.slugTried ?? "",
        _fetched_url: fetchedUrl,
        _fetch_ok: pageText !== null,
        _version: version,
      };
    } catch (err) {
      const retryAfterMs = parseRetryAfterMs(err);
      const isDailyLimit = isDailyTokenLimit(err);
      const isRateLimit = /rate_limit_exceeded|429/.test((err as any)?.message ?? "");

      console.warn(
        `  [retry ${attempt}/${MAX_RETRIES}] ${app.name}: ${(err as Error).message}` +
          (retryAfterMs ? ` (waiting ${(retryAfterMs / 1000).toFixed(1)}s as instructed)` : "")
      );

      if (isDailyLimit) {
        // A daily (TPD) cap is a hard wall that clears in MINUTES, not the
        // few seconds a normal per-minute 429 needs. Burning through
        // MAX_RETRIES worth of 1.5s/3s/4.5s backoffs here just fails every
        // remaining app for nothing. Instead: do ONE long wait for exactly
        // as long as Groq told us, on its own separate retry budget, then
        // try this same attempt again without spending it from MAX_RETRIES.
        tpdRetries++;
        if (tpdRetries > MAX_TPD_RETRIES) {
          console.warn(
            `  [daily token cap] ${app.name}: gave up after ${MAX_TPD_RETRIES} long waits — marking failed for now, safe to pick up later with --resume.`
          );
        } else {
          const waitMs = Math.min(retryAfterMs ?? 5 * 60_000, MAX_TPD_WAIT_MS);
          console.warn(
            `  [daily token cap] ${app.name}: waiting ${(waitMs / 60_000).toFixed(
              1
            )} min for the TPD window to free up (attempt ${tpdRetries}/${MAX_TPD_RETRIES})...`
          );
          await sleep(waitMs);
          attempt--; // don't consume the normal retry budget for this
          continue;
        }
      } else if (isRateLimit) {
        // Ordinary per-minute rate limit — Groq's own short wait is enough.
        await sleep(retryAfterMs ?? 5000 * attempt);
        if (attempt < MAX_RETRIES) continue;
      }

      if (attempt === MAX_RETRIES || (isDailyLimit && tpdRetries > MAX_TPD_RETRIES)) {
        return {
          id: app.id,
          name: app.name,
          category: app.category,
          one_liner: "",
          auth_methods: [],
          access: "unclear",
          api_surface: { type: "none found", breadth: "unknown" },
          has_mcp: false,
          mcp_source: "unknown",
          buildable_verdict: "unclear",
          blocker: isDailyLimit ? "daily token cap hit — rerun with --resume" : "agent failed to produce valid output",
          evidence_url: "",
          confidence: "low",
          notes: "",
          has_composio_toolkit: composioInfo?.exists ?? false,
          composio_tool_count: composioInfo?.toolCount ?? 0,
          composio_slug_tried: composioInfo?.slugTried ?? "",
          _error: (err as Error).message,
          _version: version,
        };
      }
      await sleep(1500 * attempt); // backoff before retrying
    }
  }

  // unreachable, satisfies TS
  throw new Error("unexpected exit from retry loop");
}

// ---------- main research pass ----------

async function runResearch(version: "v1" | "v2", onlyIds?: number[]) {
  const allApps = loadApps();
  const apps = onlyIds ? allApps.filter((a) => onlyIds.includes(a.id)) : allApps;

  // Load whatever's already in results.json — used both for --resume
  // (skip apps that already succeeded) and as the base we merge new
  // results into after EVERY app, not just at the end.
  let existing: ResearchResult[] = [];
  if (fs.existsSync(RESULTS_PATH)) {
    existing = JSON.parse(fs.readFileSync(RESULTS_PATH, "utf-8"));
  }
  const existingById = new Map(existing.map((r) => [r.id, r]));

  console.log(
    `Running research pass (${version}) on ${apps.length} apps${RESUME ? " (--resume: skipping already-succeeded apps)" : ""}...`
  );
  const results: ResearchResult[] = [];

  for (const [index, app] of apps.entries()) {
    if (RESUME) {
      const prior = existingById.get(app.id);
      // "Succeeded" = no _error recorded. Apps that failed (including ones
      // that hit the daily token cap) get re-tried; ones that worked don't
      // waste more of an already-scarce daily budget.
      if (prior && !prior._error) {
        console.log(`[${index + 1}/${apps.length}] ${app.name} ... skipped (already have a result, --resume)`);
        results.push(prior);
        continue;
      }
    }

    process.stdout.write(`[${index + 1}/${apps.length}] ${app.name} ... `);
    const result = await researchOneApp(app, version);
    const composioTag = result.has_composio_toolkit
      ? `, composio: ${result.composio_tool_count} tools`
      : "";
    console.log(
      result._error
        ? `FAILED (${result._error})`
        : `done (confidence: ${result.confidence}${composioTag})`
    );
    results.push(result);

    // Checkpoint after EVERY app, not just at the end. A daily-token-cap
    // wait can run into many minutes; if the process gets killed during
    // one, we don't want to lose everything computed before it.
    existingById.set(result.id, result);
    const checkpointMerged = [...existingById.values()].sort((a, b) => a.id - b.id);
    fs.writeFileSync(RESULTS_PATH, JSON.stringify(checkpointMerged, null, 2));

    await sleep(700); // small gap to avoid bursting the requests-per-minute cap too;
    // the bulk of the pacing is handled by the token limiter inside researchOneApp
  }

  const merged = [...existingById.values()].sort((a, b) => a.id - b.id);
  fs.writeFileSync(RESULTS_PATH, JSON.stringify(merged, null, 2));
  fs.writeFileSync(
    path.join(__dirname, `results-${version}.json`),
    JSON.stringify(results, null, 2)
  );
  const failedCount = results.filter((r) => r._error).length;
  console.log(
    `\nSaved ${merged.length} results -> results.json (snapshot: results-${version}.json)` +
      (failedCount > 0
        ? `\n${failedCount} app(s) failed this pass — rerun with --resume to retry just those.`
        : "")
  );
}

// ---------- verification sampling ----------

function pickVerificationSample(sampleSize = 20) {
  if (!fs.existsSync(RESULTS_PATH)) {
    console.error("No results.json yet — run research first.");
    return;
  }
  const results: ResearchResult[] = JSON.parse(fs.readFileSync(RESULTS_PATH, "utf-8"));

  const low = results.filter((r) => r.confidence === "low");
  const high = results.filter((r) => r.confidence !== "low");

  // Weight toward low-confidence (where the agent admitted doubt) and
  // a smaller number of high-confidence ones (to catch overconfidence).
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
    human_verdict: "", // fill in: CORRECT / PARTIALLY CORRECT / INCORRECT
    human_notes: "",
  }));

  fs.writeFileSync(SAMPLE_PATH, JSON.stringify(sampleWithChecklist, null, 2));
  console.log(
    `Wrote ${sampleWithChecklist.length} apps to verification-sample.json ` +
      `(${lowCount} low-confidence, ${highCount} high-confidence). ` +
      `Fill in human_verdict/human_notes by hand, then re-run patterns.`
  );
}

// ---------- pattern / cluster analysis ----------

function computePatterns() {
  if (!fs.existsSync(RESULTS_PATH)) {
    console.error("No results.json yet — run research first.");
    return;
  }
  const results: ResearchResult[] = JSON.parse(fs.readFileSync(RESULTS_PATH, "utf-8"));

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

  fs.writeFileSync(PATTERNS_PATH, JSON.stringify(patterns, null, 2));
  console.log("Wrote patterns.json. Summary:");
  console.log(JSON.stringify(patterns, null, 2));
}

// ---------- one-time Composio connection setup ----------
// Composio requires a Connected Account behind a userId before tools.execute()
// will run ANYTHING for that toolkit — even public, read-only calls like
// fetching a public repo's metadata. This is a one-time setup step: run
// `pnpm connect-github` once, follow the printed URL to authorize, and the
// connection persists on Composio's side from then on for COMPOSIO_USER_ID.
//
// NOTE: composio.toolkits.authorize() is the method name in current Composio
// SDK docs. Your installed @composio/core is 0.1.55 (noticeably behind the
// 0.13.x line) — if this throws "not a function", either:
//   1. Run `npm install @composio/core@latest` to update, or
//   2. Skip this entirely and add a Connected Account by hand from the
//      Composio dashboard (composio.dev -> your project -> Connected Accounts
//      -> Add -> GitHub), which works regardless of SDK version.
async function connectGithub() {
  if (!composio) {
    console.error("COMPOSIO_API_KEY not set — cannot connect an account.");
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
    console.log("You can now run `pnpm github` — it will use this connected account.");
  } catch (err) {
    console.error(`\nCouldn't complete the connection: ${(err as Error).message}`);
    console.error(
      "If this says something like 'not a function', your @composio/core version is too old for " +
        "this method — either run `npm install @composio/core@latest`, or add a Connected Account " +
        "manually from the Composio dashboard (composio.dev -> Connected Accounts -> Add -> GitHub)."
    );
  }
}

// ---------- Composio GitHub sub-task ----------
// Demonstrates real Composio SDK usage: pulling live repo signals for
// apps in the list that are open-source, as a distinct, honestly-labeled
// part of the pipeline (not forced onto all 100 apps). Separate from, and
// unaffected by, the toolkit-verification check wired into the main
// research loop above.

async function runComposioGithubCheck() {
  if (!composio) {
    console.error("COMPOSIO_API_KEY not set — cannot run the github sub-task.");
    return;
  }

  const apps = loadApps();
  const ossApps = apps.filter((a) => a.hint.includes("github.com"));

  if (ossApps.length === 0) {
    console.log("No github.com-hinted apps found in apps.json.");
    return;
  }

  const userId = COMPOSIO_USER_ID;

  const tools = await composio.tools.get(userId, { toolkits: ["GITHUB"] });
  console.log(`Loaded ${tools.length} GitHub tools from Composio for ${ossApps.length} OSS apps.`);

  const output: Record<string, unknown>[] = [];
  let warnedAboutConnection = false;

  for (const app of ossApps) {
    const match = app.hint.match(/github\.com\/([\w-]+)\/([\w.-]+)/);
    if (!match) continue;
    const [, owner, repo] = match;

    try {
      const result = await composio.tools.execute("GITHUB_GET_A_REPOSITORY", {
        userId,
        arguments: { owner, repo },
      });
      output.push({ app: app.name, owner, repo, composio_result: result });
      console.log(`  ${app.name}: fetched repo metadata via Composio`);
    } catch (err) {
      const message = (err as Error).message;
      output.push({ app: app.name, owner, repo, error: message });
      console.warn(`  ${app.name}: Composio call failed — ${message}`);

      // Don't repeat the same explanation for every OSS app in the list —
      // print the fix once, the first time we see this specific error.
      if (!warnedAboutConnection && /no connected account/i.test(message)) {
        warnedAboutConnection = true;
        console.warn(
          `\n  [composio] No GitHub account is connected for user "${userId}" yet.\n` +
            `  This is a one-time setup step: run \`pnpm connect-github\`, follow the printed\n` +
            `  URL to authorize, then re-run \`pnpm github\`.\n`
        );
      }
    }
    await sleep(1000);
  }

  fs.writeFileSync(GITHUB_PATH, JSON.stringify(output, null, 2));
  console.log(`Saved ${output.length} Composio-sourced repo records -> composio-github.json`);
}

// ---------- CLI dispatch ----------

async function main() {
  const cmd = process.argv[2] || "research";

  switch (cmd) {
    case "research": {
      const rerun = process.argv.includes("--rerun");
      await runResearch(rerun ? "v2" : "v1");
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