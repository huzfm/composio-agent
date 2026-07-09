// report.ts
// Generates the single self-contained HTML deliverable from:
//   results.json, patterns.json, and (optionally)
//   verification-sample-v1.json / verification-sample-v2.json
//
// Run after: npm run research && npm run patterns && npm run sample
// (and ideally: fill in human_verdict by hand, rename to -v1,
//  fix prompt, npm run research:rerun, npm run sample again, rename to -v2)
//
// Usage: npm run report

import fs from "fs";
import path from "path";

const DIR = __dirname;
const results = JSON.parse(fs.readFileSync(path.join(DIR, "results.json"), "utf-8"));
const patterns = JSON.parse(fs.readFileSync(path.join(DIR, "patterns.json"), "utf-8"));

function readIfExists(file: string) {
  const p = path.join(DIR, file);
  return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, "utf-8")) : null;
}

const sampleV1 = readIfExists("verification-sample-v1.json");
const sampleV2 = readIfExists("verification-sample-v2.json");
const sampleLatest = readIfExists("verification-sample.json");
const verificationSample = (sampleV2 || sampleLatest || []) as any[];
const hasVerificationSample = verificationSample.length > 0;
const githubProof = readIfExists("composio-github.json");

function accuracyOf(sample: any[] | null) {
  if (!sample) return null;
  const scored = sample.filter((s) => s.human_verdict);
  if (scored.length === 0) return null;
  const correct = scored.filter((s) => s.human_verdict === "CORRECT").length;
  return { correct, total: scored.length, pct: Math.round((correct / scored.length) * 100) };
}

const accV1 = accuracyOf(sampleV1);
const accV2 = accuracyOf(sampleV2 || sampleLatest);

const topBlockers = patterns.top_blockers as [string, number][];
const categoryRows = patterns.category_breakdown as any[];

function escapeHtml(s: unknown) {
  return String(s ?? "").replace(/[&<>"']/g, (c: string) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] as string)
  );
}

const tableRows = results
  .map(
    (r: any) => `
  <tr data-category="${escapeHtml(r.category)}" data-access="${escapeHtml(r.access)}" data-verdict="${escapeHtml(r.buildable_verdict)}" data-confidence="${escapeHtml(r.confidence)}">
    <td>${escapeHtml(r.name)}</td>
    <td>${escapeHtml(r.category)}</td>
    <td>${escapeHtml((r.auth_methods || []).join(", "))}</td>
    <td><span class="pill pill-${escapeHtml(r.access)}">${escapeHtml(r.access)}</span></td>
    <td>${escapeHtml(r.api_surface?.type)} / ${escapeHtml(r.api_surface?.breadth)}</td>
    <td>${r.has_mcp ? "✅ " + escapeHtml(r.mcp_source) : "—"}</td>
    <td>${r.has_composio_toolkit ? `✅ ${escapeHtml(r.composio_tool_count)} tools` : "—"}</td>
    <td><span class="pill pill-${escapeHtml(r.buildable_verdict)}">${escapeHtml(r.buildable_verdict)}</span></td>
    <td>${escapeHtml(r.blocker)}</td>
    <td>${r.evidence_url ? `<a href="${escapeHtml(r.evidence_url)}" target="_blank" rel="noopener">source</a>` : "—"}</td>
    <td><span class="conf conf-${escapeHtml(r.confidence)}">${escapeHtml(r.confidence)}</span></td>
  </tr>`
  )
  .join("\n");

const categoryOptions = Object.keys(patterns.category_breakdown ? {} : {});
const uniqueCategories = [...new Set(results.map((r: any) => r.category))].sort();
const uniqueAccess = [...new Set(results.map((r: any) => r.access))].sort();
const uniqueVerdicts = [...new Set(results.map((r: any) => r.buildable_verdict))].sort();

const verificationRows = verificationSample
  .map(
    (s: any) => `
  <tr>
    <td>${escapeHtml(s.name)}</td>
    <td>${escapeHtml(s.agent_said?.access)}</td>
    <td>${escapeHtml(s.agent_said?.confidence)}</td>
    <td class="verdict-${escapeHtml(s.human_verdict).toLowerCase().replace(/\s+/g, "-")}">${escapeHtml(s.human_verdict || "pending")}</td>
    <td>${escapeHtml(s.human_notes)}</td>
  </tr>`
  )
  .join("\n");

const githubProofSection = githubProof
  ? `
  <section class="card">
    <h2>Composio SDK in action</h2>
    <p>For open-source apps in the list, the pipeline calls Composio's <code>GITHUB</code> toolkit directly (<code>composio.tools.execute("GITHUB_GET_A_REPOSITORY", ...)</code>) to pull live repo metadata — a distinct, clearly-labeled use of Composio's own SDK, separate from the main research loop.</p>
    <ul class="proof-list">
      ${githubProof
        .map(
          (g: any) =>
            `<li><strong>${escapeHtml(g.app)}</strong> — ${
              g.error ? `<span class="err">failed: ${escapeHtml(g.error)}</span>` : "fetched via Composio ✅"
            }</li>`
        )
        .join("\n")}
    </ul>
  </section>`
  : "";

const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>Toolkit Buildability Audit — 100 Apps</title>
<style>
  :root {
    --bg: #0b0d12;
    --card: #14171f;
    --border: #262b36;
    --text: #e8eaed;
    --muted: #9aa1ac;
    --accent: #6ea8fe;
    --green: #3ecf8e;
    --amber: #f5b942;
    --red: #f2545b;
  }
  * { box-sizing: border-box; }
  body {
    background: var(--bg);
    color: var(--text);
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    margin: 0;
    padding: 0 0 4rem;
  }
  header {
    padding: 3rem 2rem 2rem;
    max-width: 1100px;
    margin: 0 auto;
  }
  header h1 { font-size: 1.9rem; margin-bottom: 0.25rem; }
  header p.sub { color: var(--muted); margin-top: 0; }
  main { max-width: 1100px; margin: 0 auto; padding: 0 2rem; }
  .card {
    background: var(--card);
    border: 1px solid var(--border);
    border-radius: 12px;
    padding: 1.75rem;
    margin-bottom: 1.5rem;
  }
  .headline-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
    gap: 1rem;
    margin-top: 1rem;
  }
  .stat {
    background: rgba(255,255,255,0.03);
    border: 1px solid var(--border);
    border-radius: 10px;
    padding: 1rem;
  }
  .stat .num { font-size: 1.8rem; font-weight: 700; color: var(--accent); }
  .stat .label { color: var(--muted); font-size: 0.85rem; }
  h2 { font-size: 1.2rem; margin-top: 0; margin-bottom: 1.2rem; }
  table { width: 100%; border-collapse: collapse; font-size: 0.9rem; }
  th, td { text-align: left; padding: 0.8rem 1rem; border-bottom: 1px solid var(--border); }
  th { 
    color: var(--muted); 
    font-weight: 600; 
    position: sticky; 
    top: 0; 
    background: var(--card); 
    cursor: pointer; 
    text-transform: uppercase;
    font-size: 0.75rem;
    letter-spacing: 0.05em;
    z-index: 10;
    box-shadow: 0 1px 0 var(--border);
    border-bottom: none;
    transition: color 0.2s ease, background-color 0.2s ease;
  }
  th:hover { color: var(--text); background: #1c202a; }
  tr { transition: background-color 0.15s ease; }
  tbody tr:nth-child(even) { background: rgba(255,255,255,0.015); }
  tr:hover { background: rgba(255,255,255,0.04); }
  td { color: #cfd4dc; }
  td:first-child { font-weight: 600; color: #fff; }
  .pill { padding: 4px 10px; border-radius: 6px; font-size: 0.75rem; border: 1px solid var(--border); font-weight: 500; display: inline-block; white-space: nowrap; }
  .pill-self-serve-free, .pill-yes-today { background: rgba(62,207,142,0.12); color: var(--green); border-color: rgba(62,207,142,0.3); }
  .pill-self-serve-paid, .pill-yes-with-friction { background: rgba(245,185,66,0.12); color: var(--amber); border-color: rgba(245,185,66,0.3); }
  .pill-gated-approval, .pill-gated-partnership, .pill-blocked { background: rgba(242,84,91,0.12); color: var(--red); border-color: rgba(242,84,91,0.3); }
  .conf-high { color: var(--green); font-weight: 600; }
  .conf-medium { color: var(--amber); font-weight: 600; }
  .conf-low { color: var(--red); font-weight: 600; }
  .filters { display: flex; gap: 1rem; flex-wrap: wrap; margin-bottom: 1.5rem; align-items: center; }
  select, input[type=text] {
    background: #1a1d24; color: var(--text); border: 1px solid var(--border);
    border-radius: 8px; padding: 0.6rem 0.8rem; font-size: 0.9rem;
    transition: all 0.2s ease;
    outline: none;
  }
  select:hover, input[type=text]:hover { border-color: #3b4252; }
  select:focus, input[type=text]:focus { border-color: var(--accent); box-shadow: 0 0 0 2px rgba(110,168,254,0.2); }
  .table-wrap { 
    max-height: 600px; 
    overflow: auto; 
    border: 1px solid var(--border); 
    border-radius: 12px; 
    background: var(--card);
    box-shadow: 0 4px 20px rgba(0, 0, 0, 0.15);
  }
  .table-wrap::-webkit-scrollbar { width: 8px; height: 8px; }
  .table-wrap::-webkit-scrollbar-track { background: var(--card); border-radius: 12px; }
  .table-wrap::-webkit-scrollbar-thumb { background: #3b4252; border-radius: 12px; }
  .table-wrap::-webkit-scrollbar-thumb:hover { background: #4c566a; }
  .verdict-correct { color: var(--green); font-weight: 600; }
  .verdict-partially-correct { color: var(--amber); font-weight: 600; }
  .verdict-incorrect { color: var(--red); font-weight: 600; }
  .accuracy-compare { display: flex; gap: 2rem; align-items: center; margin-top: 1rem; }
  .accuracy-box { text-align: center; }
  .accuracy-box .pct { font-size: 2.2rem; font-weight: 800; }
  .arrow { font-size: 1.5rem; color: var(--muted); }
  .proof-list { list-style: none; padding: 0; }
  .proof-list li { padding: 0.35rem 0; border-bottom: 1px solid var(--border); }
  .err { color: var(--red); }
  code { background: rgba(255,255,255,0.06); padding: 1px 5px; border-radius: 4px; font-size: 0.85em; }
  footer { text-align: center; color: var(--muted); font-size: 0.8rem; padding: 2rem; }
</style>
</head>
<body>

<header>
  <h1>Toolkit Buildability Audit — 100 Apps</h1>
  <p class="sub">Researched by an AI agent (Groq <code>groq/compound</code>, built-in web search), verified by hand, patterns clustered below.</p>
</header>

<main>

  <section class="card">
    <h2>Headline patterns</h2>
    <div class="headline-grid">
      <div class="stat"><div class="num">${patterns.total_apps}</div><div class="label">apps researched</div></div>
      <div class="stat"><div class="num">${patterns.buildable_verdict_distribution["yes-today"] || 0}</div><div class="label">buildable today</div></div>
      <div class="stat"><div class="num">${patterns.apps_with_existing_mcp}</div><div class="label">already have an MCP</div></div>
      <div class="stat"><div class="num">${patterns.apps_with_existing_composio_toolkit ?? 0}</div><div class="label">verified Composio toolkit</div></div>
      <div class="stat"><div class="num">${
        Object.entries(patterns.access_distribution)
          .filter(([k]) => k.startsWith("gated"))
          .reduce((sum, [, v]) => sum + (v as number), 0)
      }</div><div class="label">gated (approval / partnership)</div></div>
    </div>
    <p style="margin-top:1.25rem; color: var(--muted);">
      Top blocker across all apps found "not buildable today": <strong style="color: var(--text)">${
        topBlockers[0] ? topBlockers[0][0] : "n/a"
      }</strong> (${topBlockers[0] ? topBlockers[0][1] : 0} apps).
    </p>
  </section>

  <section class="card">
    <h2>Category breakdown</h2>
    <div class="table-wrap">
    <table>
      <thead><tr><th>Category</th><th>Total</th><th>Self-serve</th><th>Gated</th><th>Buildable today</th><th>Has MCP</th><th>Composio toolkit</th></tr></thead>
      <tbody>
        ${categoryRows
          .map(
            (c: any) => `<tr>
          <td>${escapeHtml(c.category)}</td>
          <td>${c.total}</td>
          <td>${c.self_serve}</td>
          <td>${c.gated}</td>
          <td>${c.buildable_today}</td>
          <td>${c.with_mcp}</td>
          <td>${c.with_composio_toolkit ?? 0}</td>
        </tr>`
          )
          .join("\n")}
      </tbody>
    </table>
    </div>
  </section>

  <section class="card">
    <h2>Verification — did the agent get it right?</h2>
    ${
      accV1 && accV2
        ? `
    <div class="accuracy-compare">
      <div class="accuracy-box">
        <div class="pct" style="color: var(--amber)">${accV1.pct}%</div>
        <div class="label">first pass (v1)<br/>${accV1.correct}/${accV1.total} sampled correct</div>
      </div>
      <div class="arrow">→</div>
      <div class="accuracy-box">
        <div class="pct" style="color: var(--green)">${accV2.pct}%</div>
        <div class="label">after fixing the prompt (v2)<br/>${accV2.correct}/${accV2.total} sampled correct</div>
      </div>
    </div>`
        : accV2
        ? `<p>Sampled accuracy: <strong>${accV2.pct}%</strong> (${accV2.correct}/${accV2.total} correct on human spot-check). Run a v2 pass after fixing issues to show the before/after improvement.</p>`
        : `<p style="color:var(--amber)">No verification scored yet — run <code>pnpm sample</code>, fill in <code>human_verdict</code> by hand in verification-sample.json, then re-generate this report.</p>`
    }
    <div class="table-wrap" style="margin-top:1rem;">
      <table>
        <thead><tr><th>App</th><th>Agent said (access)</th><th>Agent confidence</th><th>Human verdict</th><th>Notes</th></tr></thead>
        <tbody>${verificationRows || `<tr><td colspan="5" style="color:var(--muted)">No sample generated yet.</td></tr>`}</tbody>
      </table>
    </div>
  </section>

  ${githubProofSection}

  <section class="card">
    <h2>Full findings (all ${patterns.total_apps} apps)</h2>
    <div class="filters">
      <select id="filterCategory"><option value="">All categories</option>${uniqueCategories
        .map((c) => `<option value="${escapeHtml(c)}">${escapeHtml(c)}</option>`)
        .join("")}</select>
      <select id="filterAccess"><option value="">All access types</option>${uniqueAccess
        .map((a) => `<option value="${escapeHtml(a)}">${escapeHtml(a)}</option>`)
        .join("")}</select>
      <select id="filterVerdict"><option value="">All verdicts</option>${uniqueVerdicts
        .map((v) => `<option value="${escapeHtml(v)}">${escapeHtml(v)}</option>`)
        .join("")}</select>
      <input type="text" id="filterText" placeholder="Search app name..." />
    </div>
    <div class="table-wrap">
      <table id="mainTable">
        <thead>
          <tr>
            <th>App</th><th>Category</th><th>Auth</th><th>Access</th><th>API surface</th><th>MCP</th><th>Composio</th><th>Verdict</th><th>Blocker</th><th>Evidence</th><th>Confidence</th>
          </tr>
        </thead>
        <tbody>
          ${tableRows}
        </tbody>
      </table>
    </div>
  </section>

</main>


<script>
  const catSel = document.getElementById('filterCategory');
  const accSel = document.getElementById('filterAccess');
  const verSel = document.getElementById('filterVerdict');
  const textInput = document.getElementById('filterText');
  const rows = Array.from(document.querySelectorAll('#mainTable tbody tr'));

  function applyFilters() {
    const cat = catSel.value, acc = accSel.value, ver = verSel.value, text = textInput.value.toLowerCase();
    rows.forEach(row => {
      const matchesCat = !cat || row.dataset.category === cat;
      const matchesAcc = !acc || row.dataset.access === acc;
      const matchesVer = !ver || row.dataset.verdict === ver;
      const matchesText = !text || row.children[0].textContent.toLowerCase().includes(text);
      row.style.display = (matchesCat && matchesAcc && matchesVer && matchesText) ? '' : 'none';
    });
  }
  [catSel, accSel, verSel].forEach(el => el.addEventListener('change', applyFilters));
  textInput.addEventListener('input', applyFilters);

  // basic column sort
  document.querySelectorAll('#mainTable th').forEach((th, colIndex) => {
    th.addEventListener('click', () => {
      const tbody = document.querySelector('#mainTable tbody');
      const sorted = rows.slice().sort((a, b) =>
        a.children[colIndex].textContent.localeCompare(b.children[colIndex].textContent)
      );
      sorted.forEach(r => tbody.appendChild(r));
    });
  });
</script>

</body>
</html>`;

fs.writeFileSync(path.join(DIR, "report.html"), html);
console.log("Wrote report.html");