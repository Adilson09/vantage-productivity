import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
const value = (key, fallback) => (args.includes(key) ? args[args.indexOf(key) + 1] : fallback)
const target = path.resolve(
  value('--out', path.join(root, 'validation/implementation/Implementation-progress.html')),
)
const validationPath = path.resolve(
  value(
    '--validation',
    path.join(root, 'validation/implementation/Vantage-Implementation-Validation.json'),
  ),
)
const choices = JSON.parse(
  fs.readFileSync(path.join(root, 'docs/implementation/choices.json'), 'utf8'),
)
const evidence = fs.existsSync(validationPath)
  ? JSON.parse(fs.readFileSync(validationPath, 'utf8'))
  : null
const developmentPath = path.join(root, 'docs/implementation/next-development-evidence.json')
const development = fs.existsSync(developmentPath)
  ? JSON.parse(fs.readFileSync(developmentPath, 'utf8'))
  : null
const escape = (v) =>
  String(v ?? '').replace(
    /[&<>"']/g,
    (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch],
  )
const url = (p) => pathToFileURL(p).href
const sourceEvidence = [
  'advanced-evidence.json',
  'excel-calculation-evidence.json',
  'inspection-evidence.json',
  'native-corpus-evidence.json',
  'office-reference-smoke-raster.json',
  'office-reference-evidence.json',
  'engine-smoke-evidence.json',
  'open-source-components.json',
]
const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Vantage implementation progress</title><style>
:root{color-scheme:light dark;--bg:#f1f5f7;--paper:#fff;--ink:#19313c;--muted:#536773;--line:#ccdce2;--accent:#176b6a}*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.6 system-ui,sans-serif}header{padding:40px max(24px,calc((100vw - 1160px)/2));background:#143c45;color:#fff}header p{max-width:80ch}main{max-width:1208px;margin:auto;padding:24px}h1{font-size:clamp(2rem,4vw,3.5rem);line-height:1.1}h2{margin-top:2rem}a{color:var(--accent);text-underline-offset:3px}.note{padding:18px;border-left:4px solid var(--accent);background:var(--paper)}.grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:16px}.card{border:1px solid var(--line);border-radius:10px;padding:20px;background:var(--paper)}.card h3{margin-top:0}.status{font-size:.8rem;font-weight:700;text-transform:uppercase;letter-spacing:.04em;color:var(--accent)}.remaining{border-top:1px solid var(--line);padding-top:12px;color:var(--muted)}table{border-collapse:collapse;width:100%;background:var(--paper)}th,td{text-align:left;padding:12px;border:1px solid var(--line);vertical-align:top}td a{overflow-wrap:anywhere}.scroll{overflow:auto}button,input{font:inherit;padding:10px;border:1px solid var(--line);border-radius:6px;background:var(--paper);color:var(--ink)}input{width:100%;margin-bottom:20px}a:focus-visible,input:focus-visible{outline:3px solid var(--accent);outline-offset:3px}.small{font-size:.87rem;color:var(--muted)}@media(max-width:700px){.grid{grid-template-columns:1fr}main{padding:16px}}@media(prefers-color-scheme:dark){:root{--bg:#111f29;--paper:#1a2e39;--ink:#edf5f7;--muted:#b1c7cf;--line:#395663;--accent:#8bdfd5}}@media print{input{display:none}.grid{display:block}.card{break-inside:avoid;margin-bottom:16px}header{background:none;color:#111;padding:0}main{padding:0}body{background:#fff;color:#111}}
</style></head><body><header><p>ENGINE DEVELOPMENT</p><h1>Vantage Productivity</h1><p>Implementation progress for all 32 review areas. Published preview ${escape(choices.candidate)}${development ? `; current development ${escape(development.version)}` : ''}. Native editing engines remain central; specialist open source components fill selected gaps.</p></header><main>
<p class="note"><strong>Development preview.</strong> This is a progress and evidence record. Implemented features, passing component checks, actual desktop workflows and independent Office acceptance have different scopes. Remaining work is explicit for every area.</p>
${development ? `<h2>Published on GitHub</h2><p><a href="${escape(development.publishedPreview.url)}">Download ${escape(development.publishedPreview.version)}: Windows preview, matching source and checksums</a>. The repository remains ${escape(development.publishedPreview.visibility)}. This is an unsigned development prerelease.</p><h2>Current development: ${escape(development.version)}</h2><p>Updated ${escape(development.updatedAt)}. ${escape(development.scope)}</p><p class="note"><strong>The next version is not yet packaged or published.</strong> The overall implementation goal remains active.</p><div class="grid">${development.workstreams.map((item) => `<article class="card"><p class="status">${escape(item.status.replaceAll('-', ' '))}</p><h3>${escape(item.area)}</h3><p>${escape(item.result)}</p><p class="remaining"><strong>Next:</strong> ${escape(item.remaining)}</p>${item.url ? `<p><a href="${escape(item.url)}">Review on GitHub</a></p>` : ''}<ul>${item.evidence.map((file) => `<li><a href="${escape(url(file))}">Evidence: ${escape(path.basename(file))}</a></li>`).join('')}</ul></article>`).join('')}</div>` : ''}
<h2>Published preview validation: ${escape(choices.candidate)}</h2><p>${evidence ? `Recorded ${escape(evidence.finishedAt || evidence.startedAt)}. ${evidence.completedChecksPassed ? 'The checks in this record passed.' : 'Some checks failed, were unavailable, or were incomplete in this record.'}` : 'No candidate validation record is present yet.'} Release acceptance: ${evidence?.releaseAccepted ? 'accepted' : 'incomplete'}. This historical record applies to the published preview.</p>
${evidence ? `<p><a href="${escape(url(validationPath))}">Open exact validation, toolchain and artifact hashes</a></p><div class="scroll"><table><thead><tr><th>Check</th><th>Result</th><th>Duration</th><th>Evidence</th></tr></thead><tbody>${evidence.checks.map((check) => `<tr><th>${escape(check.name)}</th><td>${escape(check.status)}<br><span class="small">${escape(check.reason || '')}</span></td><td>${typeof check.durationMs === 'number' ? `${(check.durationMs / 1000).toFixed(1)} seconds` : 'See raw log'}</td><td>${check.logPath ? `<a href="${escape(url(check.logPath))}">Raw check log</a>` : escape(check.reason || '')}</td></tr>`).join('')}</tbody></table></div>` : ''}
<h2>Independent evidence and provenance</h2><ul>${sourceEvidence
  .flatMap((name) => {
    const file = path.join(root, 'docs/implementation', name)
    return fs.existsSync(file)
      ? [`<li><a href="${escape(url(file))}">${escape(name.replace(/[-_]/g, ' '))}</a></li>`]
      : []
  })
  .join('')}</ul>
<p class="small">Excel evidence covers 1,200 formulas in 12 categories, including live dependency refresh. Office raster smoke and native package-preservation corpus are distinct from full document fidelity. Provider tests use mocked transport; no real mail is sent. The engine manifest records whether executable discovery or an actual workflow has been validated.</p>
<h2>All implementation choices: published preview record</h2><p>${escape(choices.scope)} The cards below record ${escape(choices.candidate)}; newer results appear in Current development above.</p><label for="filter">Find an area or capability</label><input id="filter" type="search" placeholder="For example: recovery, pivots, calendar, privacy"><p id="count" role="status" aria-live="polite">32 review areas</p><div class="grid" id="choices">${choices.choices.map((choice) => `<article class="card"><p class="status">${String(choice.id).padStart(2, '0')} · ${escape(choice.status.replaceAll('-', ' '))}</p><h3>${escape(choice.area)}</h3><p>${escape(choice.choice)}</p><p class="remaining"><strong>Remaining scope:</strong> ${escape(choice.remaining)}</p></article>`).join('')}</div>
<h2>Acceptance still required</h2><ul>${development ? development.remaining.map((item) => `<li>${escape(item)}</li>`).join('') : (evidence?.externalAcceptance || []).map((item) => `<li><strong>${escape(item.name)}</strong> · ${escape(item.status)}<br>${escape(item.reason)}</li>`).join('')}</ul><p class="small">The original review remains a separate historical reference. A successful launch or a library test is never reported as universal Office compatibility.</p>
</main><script>const input=document.getElementById('filter'),cards=[...document.querySelectorAll('#choices .card')];input.addEventListener('input',()=>{const words=input.value.toLowerCase().trim().split(/\\s+/).filter(Boolean);let count=0;for(const card of cards){card.hidden=!words.every(w=>card.textContent.toLowerCase().includes(w));if(!card.hidden)count++}document.getElementById('count').textContent=count+' review areas'});</script></body></html>`
fs.mkdirSync(path.dirname(target), { recursive: true })
fs.writeFileSync(target, html)
console.log(target)
