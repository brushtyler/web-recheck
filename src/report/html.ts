import type { RunResults } from '../contracts/index.js';

export const escapeHtml = (s: unknown): string =>
  String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

/** Self-contained, script-free report; every dynamic value is escaped and a strict CSP is set. */
export function renderHtml(r: RunResults): string {
  const rows = r.results
    .map((c) => `<tr><td>${escapeHtml(c.case_id)}</td><td>${escapeHtml(c.verdict)}${c.flaky ? ' (flaky)' : ''}</td><td>${escapeHtml(c.reason_code ?? '')}</td><td>${escapeHtml(c.triage?.class ?? '')}</td><td>${escapeHtml(c.attempts.length)}</td><td>${escapeHtml(c.duration_ms)}</td></tr>`)
    .join('\n');
  const reasons = (r.gate?.reasons ?? []).map((x) => `<li>${escapeHtml(x.code)}: ${escapeHtml(x.message)}</li>`).join('');
  const q = r.quarantined.map((x) => `<li>${escapeHtml(x.kind)} ${escapeHtml(x.name)} (${escapeHtml(x.reason)})</li>`).join('');
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'"><title>web-recheck ${escapeHtml(r.run_id)}</title><style>body{font-family:sans-serif}td,th{border:1px solid #ccc;padding:2px 6px}</style></head><body>
<h1>Run ${escapeHtml(r.run_id)} - ${escapeHtml(r.site_id)}</h1>
<p>Gate: <b>${escapeHtml(r.gate?.decision ?? 'n/a')}</b> | comparison_config_id: ${escapeHtml(r.comparison_config_id)} | tool ${escapeHtml(r.tool_version)}</p>
<ul>${reasons}</ul>
<table><tr><th>case</th><th>verdict</th><th>reason</th><th>triage</th><th>attempts</th><th>ms</th></tr>
${rows}
</table>
<h2>Quarantined resources</h2><ul>${q}</ul>
</body></html>
`;
}
