// Builds the "DealerDoor Build Progress" page from one PR's folder on the ci-shots branch.
// Usage: node gallery.mjs <ci-shots/pr-N folder> <out folder>
// Writes out/index.html (HTML only), out/gallery.css and out/shots/<lane>/*.png.
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const [src, out] = process.argv.slice(2);
if (!src || !out) throw new Error('usage: node gallery.mjs <pr folder> <out folder>');

const LANES = [
  { id: 'ios', name: 'iPhone app', how: 'iPhone simulator on a GitHub Mac runner (XCUITest)' },
  { id: 'android', name: 'Android app', how: 'Android emulator on a GitHub Linux runner (Compose UI tests)' },
  { id: 'admin-desktop', name: 'Admin console · desktop', how: 'Chromium at 1280 px (Playwright)', wide: true },
  { id: 'admin-phone', name: 'Admin console · phone', how: 'Chromium at Pixel 7 size (Playwright)' },
];

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const readJson = (p, fallback) => (existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : fallback);
// "03-coworker-door" → step 03, "coworker door"
const caption = (file) => {
  const [, step, rest] = file.replace(/\.png$/, '').match(/^(\d+)-(.*)$/) ?? [null, '', file];
  return { step, label: rest.replace(/-/g, ' ') };
};

mkdirSync(join(out, 'shots'), { recursive: true });
cpSync(new URL('./gallery.css', import.meta.url), join(out, 'gallery.css'));

let passed = 0, failed = 0;
const sections = LANES.map((lane) => {
  const dir = join(src, lane.id);
  if (!existsSync(dir)) {
    return `<section class="lane" id="${lane.id}">
  <div class="lane-head"><h2>${esc(lane.name)}</h2><span class="pill wait">not run yet</span></div>
  <p class="empty">No results for this lane yet. They appear after its CI job finishes.</p>
</section>`;
  }
  const meta = readJson(join(dir, 'meta.json'), {});
  const results = readJson(join(dir, 'results.json'), []);
  // Playwright's JSON report has a different shape; reduce it to the same {test, result} rows.
  const rows = Array.isArray(results) ? results : (results.suites ?? []).flatMap(function walk(s) {
    return [...(s.specs ?? []).flatMap((sp) => sp.tests.map((t) => ({ test: `${sp.title} (${t.projectName})`, result: t.results.at(-1)?.status === 'passed' ? 'Passed' : 'Failed', failure: t.results.at(-1)?.error?.message?.split('\n')[0] ?? '' }))), ...(s.suites ?? []).flatMap(walk)];
  });
  // admin-desktop and admin-phone carry the same Playwright report; keep only this lane's project.
  if (lane.id.startsWith('admin-')) rows.splice(0, rows.length, ...rows.filter((r) => r.test.endsWith(`(${lane.id.slice(6)})`)));
  const shots = readdirSync(dir).filter((f) => f.endsWith('.png')).sort();
  mkdirSync(join(out, 'shots', lane.id), { recursive: true });
  for (const f of shots) cpSync(join(dir, f), join(out, 'shots', lane.id, f));
  const ok = rows.filter((r) => r.result === 'Passed').length;
  const bad = rows.filter((r) => r.result === 'Failed').length;
  passed += ok; failed += bad;
  const status = bad ? `<span class="pill fail">${bad} failed</span>` : rows.length ? `<span class="pill pass">all ${ok} passed</span>` : '<span class="pill wait">no results</span>';
  const tests = rows.map((r) => `<li><span class="pill ${r.result === 'Passed' ? 'pass' : 'fail'}">${r.result === 'Passed' ? 'pass' : 'fail'}</span><code>${esc(r.test)}</code>${r.failure ? `<span class="why">${esc(r.failure)}</span>` : ''}</li>`).join('\n    ');
  const figures = shots.map((f) => {
    const c = caption(f);
    return `<figure><img src="shots/${lane.id}/${esc(f)}" alt="${esc(lane.name)}: ${esc(c.label)}" loading="lazy"><figcaption>${c.step ? `<b>${esc(c.step)}</b> · ` : ''}${esc(c.label)}</figcaption></figure>`;
  }).join('\n    ');
  return `<section class="lane" id="${lane.id}">
  <div class="lane-head"><h2>${esc(lane.name)}</h2>${status}<span class="meta">${esc(lane.how)}${meta.sha ? ` · commit ${esc(meta.sha.slice(0, 7))}` : ''}${meta.at ? ` · ${esc(meta.at.replace('T', ' ').replace('Z', ' UTC'))}` : ''}${meta.run ? ` · <a href="${esc(meta.run)}">CI run</a>` : ''}</span></div>
  <ul class="tests">
    ${tests}
  </ul>
  <div class="grid${lane.wide ? ' wide' : ''}">
    ${figures || '<p class="empty">No screenshots in this run.</p>'}
  </div>
</section>`;
});

const html = `<title>DealerDoor Build Progress</title>
<meta name="claude:viewport-fit-sides" content="cover">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Archivo:wght@700;800&family=Public+Sans:wght@400;600&family=JetBrains+Mono:wght@400;600&display=swap">
<link rel="stylesheet" href="gallery.css">
<main class="page">
  <header class="top">
    <span class="eyebrow">Pull request ${esc(src.match(/pr-(\d+)/)?.[1] ?? '')} · robot test run</span>
    <h1>DealerDoor Build Progress</h1>
    <p class="lede">Every push, robots open both phone apps and the admin website, sign in as a field rep and as a customer, tap through each screen and take a picture. This page shows the latest pictures and which checks passed.</p>
    <div class="totals"><span class="pill pass">${passed} passed</span>${failed ? `<span class="pill fail">${failed} failed</span>` : ''}</div>
  </header>
  ${sections.join('\n  ')}
</main>
`;
writeFileSync(join(out, 'index.html'), html);
console.log(`wrote ${join(out, 'index.html')} · ${passed} passed, ${failed} failed`);
