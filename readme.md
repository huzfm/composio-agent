# Research Agent Assignment

This project researches 100 apps and checks whether each one is buildable as an AI-agent tool integration, such as a Composio toolkit or MCP server. It outputs structured JSON plus a final browser-viewable HTML report.

The README is written for quick assignment evaluation. Start with the type check, then run either the small test pass or the full pipeline.

## 1. Quick Code Check

```bash
npm install
npx tsc --noEmit
```

This verifies the TypeScript code without calling Groq or Composio.

## 2. Add API Keys

Create `.env` in the project root:

```env
GROQ_API_KEY=your_groq_key_here
COMPOSIO_API_KEY=your_composio_key_here
```

`GROQ_API_KEY` is required for research.

`COMPOSIO_API_KEY` is optional for basic evaluation. If present, the app also verifies Composio toolkit availability and can run the GitHub proof step.

## 3. Fast Evaluation Run

Use this to confirm the assignment works without spending quota on all 100 apps:

```bash
npm run research:test
npm run patterns
npm run sample
npm run report
```

Open the generated report:

```text
src/report.html
```

## 4. Full Run

Use this for the complete 100-app pass:

```bash
npm run research
npm run patterns
npm run sample
npm run report
```

If the research run stops because of rate limits, continue later with:

```bash
npm run research:resume
```

If research results already exist and you only want to rebuild the non-Composio outputs:

```bash
npm run patterns
npm run sample
npm run report
```

## 5. Optional Composio Steps

Composio is used in two places:

| Step | What it does |
| --- | --- |
| During `npm run research` | Calls `composio.tools.get(...)` to check whether a real Composio toolkit exists for each app, then feeds that fact into the prompt. If `COMPOSIO_API_KEY` is missing, this check is skipped. |
| `npm run github` | Calls the Composio `GITHUB` toolkit for open-source apps with GitHub repo hints and writes `src/composio-github.json`. |

For the GitHub proof step, connect GitHub once:

```bash
npm run connect-github
```

Then run:

```bash
npm run github
```

## 6. What To Review

| File | Why it matters |
| --- | --- |
| `src/apps.json` | The 100 apps being researched |
| `src/prompts.ts` | The structured research prompt and verification checklist |
| `src/index.ts` | CLI pipeline: research, resume, sample, patterns, Composio checks |
| `src/report.ts` | Builds the final HTML report |
| `src/report.html` | Final deliverable after running `npm run report` |

Generated outputs are ignored by Git so an evaluator can rerun the pipeline cleanly.

## 7. MCP Scope

MCP is researched, not launched locally.

For each app, the agent records:

- `has_mcp`
- `mcp_source`

Those fields appear in `results.json`, are counted in `patterns.json`, and are displayed in the final report.

## 8. Common Notes

- If a command says `No results.json yet`, run `npm run research:test` or `npm run research` first.
- If Groq rate limits the full run, use `npm run research:resume` later.
- If Composio says no connected account exists, run `npm run connect-github` first.
- Fastest evaluator path: `npx tsc --noEmit`, `npm run research:test`, `npm run patterns`, `npm run sample`, `npm run report`.