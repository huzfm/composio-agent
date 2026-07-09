import fs from "fs";
import path from "path";
import Groq from "groq-sdk";
import { Composio } from "@composio/core";
import {
  buildResearchPromptWithContext,
  AppInput,
  ComposioCheckResult,
} from "./prompts";

const MODEL = "llama-3.3-70b-versatile";
const MAX_RETRIES = 4;
const TPM_LIMIT = 12000;
const TPM_SAFETY_MARGIN = 0.8;
const ESTIMATED_TOKENS_PER_CALL = 2200;
const MAX_PAGE_CHARS = 6000;
const FETCH_TIMEOUT_MS = 8000;

const COMPOSIO_USER_ID = "research-agent@local";
const COMPOSIO_TIMEOUT_MS = 8000;
const COMPOSIO_CALL_GAP_MS = 350;

const MAX_TPD_WAIT_MS = 20 * 60 * 1000;
const MAX_TPD_RETRIES = 4;

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });
const composio: Composio | null = process.env.COMPOSIO_API_KEY
  ? new Composio({ apiKey: process.env.COMPOSIO_API_KEY })
  : null;

export type ResearchVersion = "v1" | "v2";

export interface ResearchResult {
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
  has_composio_toolkit: boolean;
  composio_tool_count: number;
  composio_slug_tried: string;
  _tools_used?: unknown;
  _fetched_url?: string | null;
  _fetch_ok?: boolean;
  _error?: string;
  _version?: ResearchVersion;
}

export interface RunResearchOptions {
  appsPath: string;
  resultsPath: string;
  version: ResearchVersion;
  resume?: boolean;
  onlyIds?: number[];
}

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

function loadApps(appsPath: string): AppInput[] {
  return JSON.parse(fs.readFileSync(appsPath, "utf-8"));
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function stripFences(text: string): string {
  return text.replace(/```json/gi, "").replace(/```/g, "").trim();
}

function parseRetryAfterMs(err: unknown): number | null {
  const message = (err as any)?.message ?? String(err);
  const match = message.match(/try again in (?:(\d+)m)?([\d.]+)s/i);
  if (!match) return null;
  const mins = match[1] ? parseInt(match[1], 10) : 0;
  const secs = parseFloat(match[2]);
  return Math.ceil((mins * 60 + secs) * 1000) + 500;
}

function isDailyTokenLimit(err: unknown): boolean {
  const message = (err as any)?.message ?? String(err);
  return /tokens per day|\(TPD\)/i.test(message);
}

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
    return {
      slugTried: slug,
      exists: false,
      toolCount: 0,
      sampleTools: [],
      error: (err as Error).message,
    };
  }
}

function parseUrlFromHint(hint: string): string | null {
  const firstToken = hint.trim().split(/\s+/)[0];
  if (!firstToken) return null;
  const looksLikeUrl = /^[\w.-]+\.[a-z]{2,}(\/.*)?$/i.test(firstToken);
  if (!looksLikeUrl) return null;
  return firstToken.startsWith("http") ? firstToken : `https://${firstToken}`;
}

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

async function researchOneApp(app: AppInput, version: ResearchVersion): Promise<ResearchResult> {
  const { url: fetchedUrl, text: pageText } = await fetchDocsText(app);

  const composioInfo = await checkComposioToolkit(app);
  if (composio) await sleep(COMPOSIO_CALL_GAP_MS);

  const prompt = buildResearchPromptWithContext(app, pageText, fetchedUrl, composioInfo);

  let tpdRetries = 0;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      await limiter.waitForCapacity(ESTIMATED_TOKENS_PER_CALL);

      const completion = await groq.chat.completions.create({
        model: MODEL,
        messages: [{ role: "user", content: prompt }],
      });

      const totalTokens = (completion as any)?.usage?.total_tokens ?? ESTIMATED_TOKENS_PER_CALL;
      limiter.record(totalTokens);

      const raw = completion.choices[0]?.message?.content ?? "";
      const parsed = JSON.parse(stripFences(raw));

      return {
        ...parsed,
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
        tpdRetries++;
        if (tpdRetries > MAX_TPD_RETRIES) {
          console.warn(
            `  [daily token cap] ${app.name}: gave up after ${MAX_TPD_RETRIES} long waits - marking failed for now, safe to pick up later with --resume.`
          );
        } else {
          const waitMs = Math.min(retryAfterMs ?? 5 * 60_000, MAX_TPD_WAIT_MS);
          console.warn(
            `  [daily token cap] ${app.name}: waiting ${(waitMs / 60_000).toFixed(
              1
            )} min for the TPD window to free up (attempt ${tpdRetries}/${MAX_TPD_RETRIES})...`
          );
          await sleep(waitMs);
          attempt--;
          continue;
        }
      } else if (isRateLimit) {
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
          blocker: isDailyLimit ? "daily token cap hit - rerun with --resume" : "agent failed to produce valid output",
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
      await sleep(1500 * attempt);
    }
  }

  throw new Error("unexpected exit from retry loop");
}

export async function runResearch(options: RunResearchOptions) {
  const { appsPath, resultsPath, version, resume = false, onlyIds } = options;
  const allApps = loadApps(appsPath);
  const apps = onlyIds ? allApps.filter((a) => onlyIds.includes(a.id)) : allApps;

  if (!composio) {
    console.warn(
      "  [composio] COMPOSIO_API_KEY not set - skipping toolkit verification during research."
    );
  }

  let existing: ResearchResult[] = [];
  if (fs.existsSync(resultsPath)) {
    existing = JSON.parse(fs.readFileSync(resultsPath, "utf-8"));
  }
  const existingById = new Map(existing.map((r) => [r.id, r]));

  console.log(
    `Running research pass (${version}) on ${apps.length} apps${resume ? " (--resume: skipping already-succeeded apps)" : ""}...`
  );
  const results: ResearchResult[] = [];

  for (const [index, app] of apps.entries()) {
    if (resume) {
      const prior = existingById.get(app.id);

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

    existingById.set(result.id, result);
    const checkpointMerged = [...existingById.values()].sort((a, b) => a.id - b.id);
    fs.writeFileSync(resultsPath, JSON.stringify(checkpointMerged, null, 2));

    await sleep(700);
  }

  const merged = [...existingById.values()].sort((a, b) => a.id - b.id);
  fs.writeFileSync(resultsPath, JSON.stringify(merged, null, 2));
  fs.writeFileSync(
    path.join(path.dirname(resultsPath), `results-${version}.json`),
    JSON.stringify(results, null, 2)
  );
  const failedCount = results.filter((r) => r._error).length;
  console.log(
    `\nSaved ${merged.length} results -> ${path.basename(resultsPath)} (snapshot: results-${version}.json)` +
      (failedCount > 0
        ? `\n${failedCount} app(s) failed this pass - rerun with --resume to retry just those.`
        : "")
  );
}