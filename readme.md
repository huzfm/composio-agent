# research-agent

An agent that researches 100 apps for AI-agent toolkit buildability — verifying its own findings against real docs pages and a real [Composio](https://composio.dev) toolkit check — then outputs a single self-contained `report.html` case study.

It uses:

- **Groq** (`llama-3.3-70b-versatile`) to research each app and produce structured JSON
- **Composio** to verify, for real, whether an AI-agent toolkit already exists for each app (and, separately, to pull live GitHub repo metadata for open-source apps in the list)

---

## 1. Prerequisites

- Node.js 18+ and `npm` (or `pnpm`)
- A free [Groq API key](https://console.groq.com) — no card required
- A free [Composio API key](https://composio.dev) dashboard

## 2. Setup

```bash
npm install
```

Create a `.env` file in the project root:

```
GROQ_API_KEY=your_groq_key_here
COMPOSIO_API_KEY=your_composio_key_here
```

`COMPOSIO_API_KEY` is optional — if you leave it out, the pipeline still runs. It just skips the Composio toolkit-verification check and the `github` sub-task, and tells you so in the console.

## 3. One-time Composio setup (before `github` will work)

Composio requires a **Connected Account** behind a user ID before it will run _any_ tool for that toolkit — even a public, read-only call like fetching a GitHub repo's metadata. Do this once:

```bash
npm run connect-github
```

This prints a URL. Open it, sign in with any GitHub account, and approve the OAuth prompt. The script polls in the background and confirms once it's connected:

```
Connected! Account id: ...
You can now run `pnpm github` — it will use this connected account.
```

**If it errors** (e.g. "authorize is not a function"), your installed `@composio/core` may be behind — run `npm install @composio/core@latest` and try again. As a fallback that works regardless of SDK version, you can add the Connected Account manually from the Composio dashboard instead: **composio.dev → your project → Connected Accounts → Add → GitHub**.

You only need to do this once — the connection persists on Composio's side.

## 4. Run the full pipeline

```bash
npm run all
```

This runs, in order: `research` → `patterns` → `sample` → `github` → `report`, and produces `report.html`.

Or, if you've already done `research` and just want to regenerate the rest (patterns/github/report) without re-researching all 100 apps:

```bash
npm run output
```

## 5. Run steps individually

| Command                   | What it does                                                                                                                                                                                   |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npm run research`        | First full pass over all 100 apps → `results.json`, `results-v1.json`                                                                                                                          |
| `npm run research:test`   | Quick sanity check — same thing, but only the 5-app `apps.test.json` subset                                                                                                                    |
| `npm run research:resume` | Re-runs, but **skips** any app that already has a successful result. Use this to pick up after a rate-limit wall (see Troubleshooting) without re-spending quota on apps that already finished |
| `npm run research:rerun`  | Full re-run of all 100 apps as a new "v2" pass (e.g. after fixing the prompt)                                                                                                                  |
| `npm run sample`          | Picks ~20 apps (weighted toward low-confidence) → `verification-sample.json`                                                                                                                   |
| `npm run patterns`        | Computes cluster/pattern stats from `results.json` → `patterns.json`                                                                                                                           |
| `npm run connect-github`  | **One-time.** Authorizes a GitHub account with Composio (see step 3)                                                                                                                           |
| `npm run github`          | Pulls live GitHub repo metadata via Composio for open-source apps in the list → `composio-github.json`                                                                                         |
| `npm run report`          | Builds `report.html` from all the JSON outputs                                                                                                                                                 |

## 6. The manual verification step

After `research` and `sample`:

1. Open `verification-sample.json`
2. For each entry, open the `evidence_url` and check it actually says what the agent claimed
3. Fill in `human_verdict` (`CORRECT` / `PARTIALLY CORRECT` / `INCORRECT`) and `human_notes` for each entry
4. Save a copy as `verification-sample-v1.json`
5. Fix whatever the agent got wrong — usually in `src/prompts.ts` (e.g. tighten the access-tier definitions, force a real cited URL)
6. Re-run the pass and re-verify:

```bash
npm run research:rerun
npm run sample
```

7. Manually verify again, save as `verification-sample-v2.json`, then:

```bash
npm run patterns
npm run github
npm run report
```

`report.html` will show the v1 → v2 accuracy comparison.

---

## Troubleshooting

### `Rate limit reached ... tokens per day (TPD)`

Groq's free/on-demand tier has a daily token cap (e.g. 100,000/day). Researching all 100 apps needs roughly double that, so **hitting this wall partway through a run is expected**, not a bug. The pipeline handles it automatically:

- It detects daily-limit errors specifically and does one long wait (matching the time Groq tells us to wait, capped at 20 min) instead of burning through retries in seconds
- `results.json` is saved after **every app**, not just at the end, so nothing is lost if you stop the process during a wait
- Just run `npm run research:resume` afterward (even a while later, or the next day) — it'll skip everything that already succeeded and only retry what's left

### `Composio call failed — No connected accounts found`

You haven't done the one-time Composio connection yet — see **step 3** above (`npm run connect-github`).

### `🚀 Upgrade available! Your composio-core version (0.1.55) is behind`

Not urgent, but worth doing at some point:

```bash
npm install @composio/core@latest
```

### `Cannot find module 'C:\...\index.ts'` / `ERR_MODULE_NOT_FOUND`

This means the file genuinely isn't where the script expects it. Check:

```bash
dir src\*.ts     # Windows
ls src/*.ts      # macOS/Linux
```

You should see `index.ts`, `prompts.ts`, and `report.ts` inside `src/`. If any are missing, misnamed (e.g. `index.ts.txt` — enable "File name extensions" in Windows Explorer to check), or sitting in the wrong folder, that's the fix — not a code issue.

---

## What each file does

| File                                  | Purpose                                                                              |
| ------------------------------------- | ------------------------------------------------------------------------------------ |
| `apps.json`                           | The 100-app research set (name, category, docs hint)                                 |
| `src/prompts.ts`                      | The research prompt + Composio evidence block + verification checklist template      |
| `src/index.ts`                        | CLI: research / sample / patterns / connect-github / github commands                 |
| `src/report.ts`                       | Builds the single HTML deliverable from all the JSON outputs                         |
| `results.json`                        | Latest merged research results (auto-generated, checkpointed after every app)        |
| `results-v1.json` / `results-v2.json` | Snapshots of each research pass (auto-generated)                                     |
| `verification-sample*.json`           | Human spot-check records (you fill these in)                                         |
| `patterns.json`                       | Computed cluster/pattern stats, including Composio-toolkit coverage (auto-generated) |
| `composio-github.json`                | Proof-of-use of the Composio SDK on open-source apps (auto-generated)                |
| `report.html`                         | The final deliverable — open this in a browser                                       |

## Where a human is needed

- Verifying `evidence_url`s actually say what the agent claimed
- Judging ambiguous "self-serve vs gated" cases the agent flagged low-confidence
- Fixing the prompt between v1 and v2 based on what the spot-check revealed
- The one-time Composio GitHub authorization (step 3) — this is an OAuth consent screen, it can't be automated
- Final read-through of `report.html` for honesty (apps the agent got wrong are shown, not hidden)
