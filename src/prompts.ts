// prompts.ts
// Central place for every prompt the research agent uses.
// Keeping prompts here (not inline in index.ts) makes it easy to
// tweak wording once and re-run without touching the pipeline logic.

export interface AppInput {
  id: number;
  name: string;
  category: string;
  hint: string;
}

/**
 * Result of actually querying the Composio SDK to see whether a toolkit
 * already exists for this app. This is REAL, verified data (not a model
 * guess) — see checkComposioToolkit() in index.ts.
 */
export interface ComposioCheckResult {
  slugTried: string;
  exists: boolean;
  toolCount: number;
  sampleTools: string[];
  error?: string;
}

/**
 * The single research prompt sent per app.
 * Forces strict JSON output so the pipeline can parse it directly.
 * Explicitly tells the model to flag low confidence instead of guessing —
 * this is what makes the verification step meaningful later.
 */
export function buildResearchPrompt(app: AppInput): string {
  return `You are researching software applications to evaluate whether they could be turned into an AI-agent tool integration (like a Composio toolkit or an MCP server).

App to research: "${app.name}"
Known category: ${app.category}
Hint / likely docs source: ${app.hint}

Use web search to find the ACTUAL current documentation for this app. Do not answer from memory alone — verify against a real page you found.

Determine:
1. category — one short phrase (can differ from the hint if you find a better fit)
2. one_liner — what the app does, in one plain sentence
3. auth_methods — array of: "OAuth2", "API key", "Basic", "token", "other", or "none found"
4. access — one of: "self-serve-free", "self-serve-paid", "gated-approval", "gated-partnership", "unclear"
5. api_surface — object: { "type": "REST" | "GraphQL" | "SDK-only" | "none found", "breadth": "large" | "medium" | "small" | "unknown" }
6. has_mcp — boolean: does an official or well-known community MCP server already exist for this app?
7. mcp_source — "official" | "community" | "none" | "unknown"
8. buildable_verdict — one of: "yes-today", "yes-with-friction", "blocked", "unclear"
9. blocker — short phrase describing the main blocker if not immediately buildable, else "none"
10. evidence_url — the actual docs/article URL you used to answer. This must be a real URL you found, not invented.
11. confidence — "high" | "medium" | "low". Use "low" honestly if the docs were thin, contradictory, paywalled, or you could not verify.
12. notes — anything surprising or ambiguous worth a human's attention (1 sentence, optional)

Respond with ONLY valid JSON, no markdown fences, no commentary, matching exactly this shape:

{
  "id": ${app.id},
  "name": "${app.name}",
  "category": "",
  "one_liner": "",
  "auth_methods": [],
  "access": "",
  "api_surface": { "type": "", "breadth": "" },
  "has_mcp": false,
  "mcp_source": "",
  "buildable_verdict": "",
  "blocker": "",
  "evidence_url": "",
  "confidence": "",
  "notes": ""
}`;
}

/**
 * Builds the Composio evidence block injected into the research prompt.
 * This is REAL data pulled from the Composio SDK (composio.tools.get),
 * not something the model is asked to guess — we tell it what we found
 * and let it reason about what that implies for buildability, then we
 * overwrite has_composio_toolkit / composio_tool_count ourselves after
 * parsing so the model can never quietly contradict verified ground truth.
 */
function buildComposioBlock(composio: ComposioCheckResult | null): string {
  if (!composio) {
    return `Composio check: not performed (no COMPOSIO_API_KEY configured, or check skipped).`;
  }
  if (composio.error) {
    return `Composio check: attempted to look up a toolkit named "${composio.slugTried}" but the lookup errored (${composio.error}). Treat this as "unknown", not "no toolkit exists" — it may just be a wrong slug guess.`;
  }
  if (composio.exists) {
    return `Composio check (VERIFIED, not a guess): Composio already has a live toolkit for this app (tried slug "${composio.slugTried}", found ${composio.toolCount} tool(s), e.g. ${composio.sampleTools.join(", ") || "n/a"}). This is strong evidence the app is buildable today via an existing AI-agent integration, separate from whether an MCP server exists.`;
  }
  return `Composio check (VERIFIED, not a guess): No Composio toolkit found under the slug "${composio.slugTried}". This does NOT necessarily mean no integration is possible — Composio may use a different slug for this app, or may simply not cover it yet. Do not treat this alone as proof the app is blocked.`;
}

/**
 * Used when we've fetched the docs page ourselves (see fetchDocsText in index.ts)
 * and are handing the model a bounded chunk of real page text instead of letting
 * it run its own uncontrolled internal search. This is what avoids the 413
 * "request too large" errors that groq/compound's built-in search caused —
 * we control exactly how much text goes in.
 *
 * Also injects a verified Composio toolkit-existence check (see
 * buildComposioBlock above) so the model's buildable_verdict / blocker /
 * notes can account for a REAL AI-agent-integration signal, not just guesswork.
 */
export function buildResearchPromptWithContext(
  app: AppInput,
  pageText: string | null,
  fetchedUrl: string | null,
  composio: ComposioCheckResult | null = null
): string {
  const contextBlock = pageText
    ? `Here is the actual page text fetched from ${fetchedUrl}:
"""
${pageText}
"""
Base your answer on this content. If it doesn't fully answer a field, use your general knowledge but lower your confidence accordingly and say so in "notes".`
    : `We were unable to fetch a docs page automatically for this app (URL: ${fetchedUrl ?? "not found"}).
Answer from your general knowledge only, set "confidence" to "low", and note in "blocker" or "notes" that no page could be fetched.`;

  const composioBlock = buildComposioBlock(composio);

  return `You are researching software applications to evaluate whether they could be turned into an AI-agent tool integration (like a Composio toolkit or an MCP server).

App to research: "${app.name}"
Known category: ${app.category}
Hint / likely docs source: ${app.hint}

${contextBlock}

${composioBlock}

Determine:
1. category — one short phrase (can differ from the hint if you find a better fit)
2. one_liner — what the app does, in one plain sentence
3. auth_methods — array of: "OAuth2", "API key", "Basic", "token", "other", or "none found"
4. access — one of: "self-serve-free", "self-serve-paid", "gated-approval", "gated-partnership", "unclear"
5. api_surface — object: { "type": "REST" | "GraphQL" | "SDK-only" | "none found", "breadth": "large" | "medium" | "small" | "unknown" }
6. has_mcp — boolean: does an official or well-known community MCP server already exist for this app? (This is distinct from the Composio check above — answer based on your own knowledge / the page text.)
7. mcp_source — "official" | "community" | "none" | "unknown"
8. buildable_verdict — one of: "yes-today", "yes-with-friction", "blocked", "unclear". If the verified Composio check above found an existing toolkit, that alone is usually enough to justify "yes-today" even if no MCP server exists.
9. blocker — short phrase describing the main blocker if not immediately buildable, else "none"
10. evidence_url — use "${fetchedUrl ?? ""}" if the fetched page was useful, otherwise leave blank
11. confidence — "high" | "medium" | "low". Be honest — low if the page was thin, off-topic, or unfetchable.
12. notes — anything surprising or ambiguous worth a human's attention (1 sentence, optional). Mention the Composio check result here if it's notable.

Respond with ONLY valid JSON, no markdown fences, no commentary, matching exactly this shape:

{
  "id": ${app.id},
  "name": "${app.name}",
  "category": "",
  "one_liner": "",
  "auth_methods": [],
  "access": "",
  "api_surface": { "type": "", "breadth": "" },
  "has_mcp": false,
  "mcp_source": "",
  "buildable_verdict": "",
  "blocker": "",
  "evidence_url": "",
  "confidence": "",
  "notes": ""
}`;
}

/**
 * Used during the manual verification pass — not sent to the model,
 * just a checklist template so spot-checks are consistent across apps.
 */
export function buildVerificationChecklist(app: AppInput): string {
  return `Verification checklist for "${app.name}":
[ ] Opened the evidence_url the agent cited — does it actually exist and say what was claimed?
[ ] Auth method matches what the real docs say
[ ] Access tier (self-serve vs gated) matches reality, not just what the homepage implies
[ ] API surface breadth is a reasonable characterization
[ ] MCP existence claim is correct (check github/mcp registries, not just the agent's say-so)
[ ] Composio toolkit existence (has_composio_toolkit) matches what composio.tools.get() actually returned
[ ] Buildable verdict makes sense given the above
Verdict: CORRECT / PARTIALLY CORRECT / INCORRECT
Notes on what was wrong (if anything):`;
}