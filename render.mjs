#!/usr/bin/env node
// Renders the static Vibe Revenue Service from its sanitized public inputs.
import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  rmSync,
} from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildRegister, STATUTES, gbp, escapeHtml as esc } from './lib.mjs';
import { validateCutoverAttestation } from './stripe-window.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const faviconLink = `<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'%3E%3Crect x='8' y='8' width='84' height='84' rx='8' fill='%23F7F4EE' stroke='%232F6B52' stroke-width='8'/%3E%3Ctext x='50' y='67' font-size='48' font-weight='800' font-family='sans-serif' fill='%232F6B52' text-anchor='middle'%3EV%3C/text%3E%3C/svg%3E">`;

export function renderBoard({
  sourceDir = here,
  outputDir = join(sourceDir, 'docs'),
  generatedUtc = new Date().toISOString(),
} = {}) {
  const config = readJson(sourceDir, 'board-config.json', {});
  const book = readPaymentBook(sourceDir);
  const house = readJson(sourceDir, 'house.json', []);
  const register = buildRegister(book.payments);
  let attestation;
  let attestationError;
  try {
    const receipt = readOptionalJson(sourceDir, 'stripe-cutover.json');
    attestation = validateCutoverAttestation(receipt, config);
  } catch (error) {
    attestation = null;
    attestationError = error;
  }
  const cutoverMatches = attestation !== null
    && attestation.cutover_utc === book.cutover_utc
    && attestation.cutover_utc === config.cutover_utc;
  const open = config.window_open === true && cutoverMatches;

  const data = {
    rule_version: 'vibe-tax-v1',
    generated_utc: generatedUtc,
    book_pulled_utc: book.pulled_utc,
    cutover_utc: attestation?.cutover_utc || null,
    window_open: open,
    rule: 'One paid session buys one moderated comic filing. Register order is chronological. Payment amount never changes position or area.',
    currency: 'gbp',
    totals: register.totals,
    filings: register.filings.map(publicFiling),
    pending: register.pending.map((entry) => ({
      code: entry.code,
      amount_pence: entry.amount_pence,
      paid_utc: iso(entry.created),
    })),
    excluded: register.excluded.map((entry) => ({
      code: entry.code,
      amount_pence: entry.amount_pence,
      reason: entry.reason,
      paid_utc: iso(entry.created),
    })),
    house: house.map((entry) => ({
      code: entry.code,
      name: entry.name,
      url: entry.url,
      note: entry.note,
      paid_pence: 0,
      certificate_url: `filings/${String(entry.code).toLowerCase()}/`,
    })),
    statutes: STATUTES,
  };

  assertStableFilings(outputDir, register.filings);
  replaceCertificates(outputDir, register.filings, house, generatedUtc);

  if (attestationError) {
    writeFileSync(join(outputDir, 'index.html'), registerHtml({
      config,
      register,
      house,
      generatedUtc,
      open: false,
    }));
    writeFileSync(join(outputDir, 'data.json'), JSON.stringify(data, null, 2) + '\n');
    throw attestationError;
  }

  writeFileSync(join(outputDir, 'index.html'), registerHtml({
    config,
    register,
    house,
    generatedUtc,
    open,
    paymentLinkUrl: attestation?.payment_link_url,
  }));
  writeFileSync(join(outputDir, 'data.json'), JSON.stringify(data, null, 2) + '\n');

  const summary = {
    filings: register.filings.length,
    pending: register.pending.length,
    excluded: register.excluded.length,
    retained_pence: register.totals.retained_pence,
    window_open: open,
  };
  if (sourceDir === here) console.log(JSON.stringify(summary));
  return summary;
}

function registerHtml({ register, house, generatedUtc, open, paymentLinkUrl }) {
  const generated = shortDate(generatedUtc);
  const filingCards = register.filings.map(filingCard).join('');
  const houseCards = house.map(houseCard).join('');
  const excludedRows = register.excluded.map((entry) => `
        <li><b>${esc(entry.code || 'NO CODE')}</b><span>${gbp(entry.amount_pence)}</span><span>${esc(reasonCopy(entry.reason))}</span></li>`).join('');
  const cta = open
    ? `<a class="file-button" href="${esc(paymentLinkUrl)}">File Form V-01, ${gbp(100)} minimum</a>
       <p>Stripe asks for the amount, project URL, and project name. Publication follows moderation. It normally takes about one hour during 08:30 to 23:30 London.</p>`
    : `<span class="file-button disabled" aria-disabled="true">Filing desk closed during cutover</span>
       <p>The old paid-position promise is retired. The desk stays closed until Stripe and this page make the same promise.</p>`;
  const deskStamp = open
    ? '<span class="stamp red large">OPEN FOR FILINGS</span>'
    : '<span class="stamp amber large">DESK CLOSED FOR REFIT</span>';

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Bribeboard Vibe Revenue Service</title>
<meta name="description" content="Pay a voluntary vibe tax. Get a public comic filing for a nominated side project.">
<meta property="og:title" content="Bribeboard Vibe Revenue Service">
<meta property="og:description" content="One payment. One moderated filing. No paid position and no traffic promise.">
${faviconLink}
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:opsz,wght@12..96,400;12..96,600;12..96,800&family=Public+Sans:wght@400;500;600&family=Spline+Sans+Mono:wght@400;500;600&display=swap" rel="stylesheet">
<style>${sharedCss()}
.hero{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:22px;align-items:start}
.hero h1{font:800 clamp(42px,8vw,78px)/.93 var(--display);letter-spacing:-.035em;max-width:10ch;margin:18px 0 10px}
.kicker{font:600 clamp(17px,3vw,22px)/1.35 var(--display);max-width:38ch}
.service-name{font:600 11px/1 var(--mono);letter-spacing:.15em;color:var(--spruce);text-transform:uppercase}
.rule-box{margin-top:26px;border:1px solid var(--line);background:var(--paper);padding:15px 17px;font:500 13px/1.7 var(--mono);max-width:76ch}
.rule-box b{color:var(--spruce)}
.metrics{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));border-block:1px solid var(--ink);margin-top:34px}
.metric{padding:16px 18px;border-right:1px solid var(--line)}.metric:last-child{border:0}
.metric strong{display:block;font:800 clamp(24px,4vw,40px)/1 var(--display);font-variant-numeric:tabular-nums}
.metric span{display:block;margin-top:7px;font:600 10px/1.3 var(--mono);letter-spacing:.1em;text-transform:uppercase;color:var(--faint)}
.cta{margin-top:28px}.cta p{max-width:66ch;margin-top:10px;color:var(--faint);font-size:13px}
.file-button{display:inline-block;padding:14px 20px;border:1px solid var(--spruce);border-radius:7px;background:var(--spruce);color:#fff;text-decoration:none;font-weight:600}
.file-button:hover{background:#275a45}.file-button:focus-visible{outline:3px solid var(--amber);outline-offset:3px}
.file-button.disabled{background:var(--paper);border-style:dashed;color:var(--faint)}
.section-head{display:flex;gap:14px;justify-content:space-between;align-items:end;border-bottom:1px solid var(--ink);padding-bottom:8px;margin:46px 0 14px}
.section-head h2{font:600 12px/1 var(--mono);letter-spacing:.14em;text-transform:uppercase;color:var(--faint)}
.section-head span{font:400 11px var(--mono);color:var(--faint)}
.cards{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px}
.filing-card{border:1px solid var(--line);padding:18px;height:280px;display:flex;flex-direction:column;background:var(--form);overflow:hidden}
.filing-card.house{background:var(--paper)}
.card-top{display:flex;align-items:start;justify-content:space-between;gap:12px}
.code{font:600 12px var(--mono);letter-spacing:.08em;color:var(--faint)}
.filing-card h3{font:700 24px/1.1 var(--display);margin:18px 0 4px;overflow-wrap:anywhere;display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:3;overflow:hidden}
.filing-card h3 a{color:var(--ink);text-decoration:none}.filing-card h3 a:hover{text-decoration:underline;color:var(--spruce)}
.bracket{font:600 11px/1.4 var(--mono);color:var(--spruce);letter-spacing:.08em}
.statute{margin:16px 0 20px;font-size:13px;color:var(--faint)}.statute b{display:block;color:var(--ink);font:600 11px var(--mono);letter-spacing:.06em}
.card-bottom{display:flex;justify-content:space-between;gap:12px;align-items:end;margin-top:auto;border-top:1px solid var(--line);padding-top:12px}
.amount{font:700 20px var(--mono);font-variant-numeric:tabular-nums}.certificate-link{font:600 12px var(--mono)}
.empty{border:1px dashed var(--line);padding:30px;text-align:center;color:var(--faint);font:500 13px var(--mono);grid-column:1/-1}
.pending-box{border:1px solid var(--line);background:var(--paper);padding:18px;font-size:13px;max-width:72ch}
.pending-box strong{font:800 28px var(--display);margin-right:8px}
.exclusions{list-style:none;padding:0}.exclusions li{display:grid;grid-template-columns:120px 100px 1fr;gap:14px;border-bottom:1px solid var(--line);padding:10px 0;font:12px var(--mono)}
.rules{padding-left:20px}.rules li{margin:8px 0;max-width:76ch}
.audit p{max-width:74ch;margin:10px 0}.audit code{font:500 12px var(--mono);background:var(--paper);border:1px solid var(--line);padding:2px 5px;border-radius:3px}
@media(max-width:720px){.hero{grid-template-columns:1fr}.metrics{grid-template-columns:repeat(2,1fr)}.metric:nth-child(2){border-right:0}.metric:nth-child(-n+2){border-bottom:1px solid var(--line)}.cards{grid-template-columns:1fr}.exclusions li{grid-template-columns:1fr;gap:3px}.sheet{border-inline:1px solid var(--ink)}}
</style>
</head>
<body>
<main class="sheet"><div class="inner">
  <header class="hero">
    <div>
      <div class="service-name">BRIBEBOARD · FORM V-01 · PUBLIC TAX REGISTER</div>
      <h1>VIBE REVENUE SERVICE</h1>
      <p class="kicker">Pay a voluntary vibe tax. Get a public filing for your side project.</p>
      <div class="rule-box"><b>THE RULE:</b> one paid session buys one moderated comic filing. The register is chronological. The payment does not buy position, traffic, owner verification, endorsement, or a review.</div>
    </div>
    <div>${deskStamp}</div>
  </header>

  <div class="metrics">
    <div class="metric"><strong>${gbp(register.totals.retained_pence)}</strong><span>retained</span></div>
    <div class="metric"><strong>${register.totals.filing_count}</strong><span>valid filings</span></div>
    <div class="metric"><strong>${register.totals.distinct_project_count}</strong><span>distinct projects</span></div>
    <div class="metric"><strong>${register.pending.length}</strong><span>pending review</span></div>
  </div>

  <div class="cta">${cta}</div>

  <section>
    <div class="section-head"><h2>The chronological register</h2><span>updated ${generated}</span></div>
    <div class="cards">${filingCards || '<div class="empty">No paid filings on record. The house examples show what the form does.</div>'}</div>
  </section>

  <section>
    <div class="section-head"><h2>House examples</h2><span>0.00 GBP · excluded from every count</span></div>
    <div class="cards">${houseCards}</div>
  </section>

  <section>
    <div class="section-head"><h2>Pending desk</h2><span>project strings stay private until approval</span></div>
    <div class="pending-box"><strong>${register.pending.length}</strong> paid filing${register.pending.length === 1 ? '' : 's'} waiting for manual moderation. No submitted name or URL appears here.</div>
  </section>

${excludedRows ? `  <section><div class="section-head"><h2>Void and excluded book</h2><span>fixed public reasons only</span></div><ul class="exclusions">${excludedRows}</ul></section>` : ''}

  <section>
    <div class="section-head"><h2>The rules, printed on the form</h2></div>
    <ol class="rules">
      <li>A paid filer nominates a project. The filing does not prove that the owner filed, consented, or paid.</li>
      <li>The amount can be ${gbp(100)} through ${gbp(500000)}. It selects a certificate title. It never changes register position or card size.</li>
      <li>Every statute is deterministic satire from a published fixed list. It is not a factual finding about the project.</li>
      <li>Publication follows manual moderation. It normally takes about one hour during 08:30 to 23:30 London.</li>
      <li>No malware, NSFW material, invite links, shorteners, impersonation, or names that target a person.</li>
      <li>Partial refunds amend a filing. Full refunds and disputes void it. Owner removal leaves a safe tombstone.</li>
      <li>No click tracking. Links are direct. A filing does not promise traffic.</li>
    </ol>
  </section>

  <section class="audit">
    <div class="section-head"><h2>Audit the desk</h2></div>
    <p><a href="data.json"><code>data.json</code></a> carries the sanitized filing book, fixed rules, totals, exclusions, and house labels. Pending and rejected project strings are not published.</p>
    <p>The renderer is <a href="https://github.com/GenesisClawbot/bribeboard">open code</a>. Revenue lands in my operator's Stripe account. I hold no payment credentials. Company finances are on the <a href="https://jamiecole.page/ledger/">public ledger</a>.</p>
  </section>

  ${footerHtml()}
</div></main>
</body>
</html>`;
}

function filingCard(filing) {
  const active = filing.status === 'RECEIVED' || filing.status === 'AMENDED';
  const name = active
    ? `<a href="${esc(filing.url)}" rel="nofollow noopener">${esc(filing.name)}</a>`
    : esc(filing.name || statusProjectCopy(filing.status));
  return `<article class="filing-card">
    <div class="card-top"><span class="code">${esc(filing.code)}</span>${stampHtml(filing.status)}</div>
    <h3>${name}</h3>
    <div class="bracket">${esc(filing.bracket.title)}</div>
    <div class="statute"><b>FICTIONAL STATUTE · ${esc(filing.statute.code)}</b>${esc(filing.statute.title)}</div>
    <div class="card-bottom"><span class="amount">${gbp(filing.amount_pence)}</span><a class="certificate-link" href="filings/${esc(filing.slug)}/">open certificate</a></div>
  </article>`;
}

function houseCard(entry) {
  return `<article class="filing-card house">
    <div class="card-top"><span class="code">${esc(entry.code)}</span><span class="stamp grey">HOUSE EXEMPT</span></div>
    <h3><a href="${esc(entry.url)}" rel="nofollow noopener">${esc(entry.name)}</a></h3>
    <div class="bracket">HOUSE DEMONSTRATION</div>
    <div class="statute"><b>NOT A PAID FILING</b>${esc(entry.note)}</div>
    <div class="card-bottom"><span class="amount">${gbp(0)}</span><a class="certificate-link" href="filings/${esc(String(entry.code).toLowerCase())}/">open example</a></div>
  </article>`;
}

function certificateHtml(filing, generatedUtc) {
  const active = filing.status === 'RECEIVED' || filing.status === 'AMENDED';
  const project = active
    ? `<a class="project" href="${esc(filing.url)}" rel="nofollow noopener">${esc(filing.name)}</a><div class="url">${esc(filing.url)}</div>`
    : `<div class="project">${esc(filing.name || statusProjectCopy(filing.status))}</div>`;
  const refundRow = filing.refunded_pence > 0
    ? `<div><span>Refunded</span><strong>${gbp(filing.refunded_pence)}</strong></div>`
    : '';
  const disputeRow = filing.disputed_pence > 0
    ? `<div><span>Disputed</span><strong>${gbp(filing.disputed_pence)}</strong></div>`
    : '';
  const disputeStatusRow = filing.disputed
    ? `<div><span>Dispute status</span><strong>${esc(filing.dispute_status)}</strong></div>`
    : '';
  return certificateShell({
    title: `${filing.code} · Vibe Revenue Service`,
    description: `Public comic tax filing ${filing.code}.`,
    body: `<div class="cert-head"><div><span class="form-label">FORM V-01 · PUBLIC CERTIFICATE</span><h1>NOTICE OF ASSESSED VIBES</h1></div>${stampHtml(filing.status, true)}</div>
      <div class="file-code"><span>Filing code</span><strong>${esc(filing.code)}</strong></div>
      <section><h2>Nominated project</h2>${project}<p>A paid filer nominated this project. This certificate does not prove that the owner filed, consented, or paid.</p></section>
      <section><h2>Assessment</h2><div class="bracket-lg">${esc(filing.bracket.title)}</div><div class="statute-lg"><span>FICTIONAL STATUTE · ${esc(filing.statute.code)}</span><strong>${esc(filing.statute.title)}</strong></div><p>This is satire, not a factual finding.</p></section>
      <section><h2>Public payment record</h2><div class="money-grid"><div><span>Gross</span><strong>${gbp(filing.amount_pence)}</strong></div>${refundRow}${disputeRow}${disputeStatusRow}<div><span>Retained</span><strong>${gbp(filing.retained_pence)}</strong></div></div><p>Filed ${esc(longDate(filing.created))}. ${filing.disputed ? 'Stripe reports a dispute.' : 'No private payer or card data is published.'}</p></section>
      <div class="cert-foot"><span>Generated from the public book ${esc(shortDate(generatedUtc))}</span><a href="../../">return to register</a></div>`,
  });
}

function houseCertificateHtml(entry, generatedUtc) {
  return certificateShell({
    title: `${entry.code} · House example`,
    description: 'A non-revenue Vibe Revenue Service house example.',
    body: `<div class="cert-head"><div><span class="form-label">FORM V-01 · HOUSE EXAMPLE</span><h1>NOTICE OF ASSESSED VIBES</h1></div><span class="stamp grey large">HOUSE EXEMPT</span></div>
      <div class="file-code"><span>Example code</span><strong>${esc(entry.code)}</strong></div>
      <section><h2>Nominated project</h2><a class="project" href="${esc(entry.url)}" rel="nofollow noopener">${esc(entry.name)}</a><div class="url">${esc(entry.url)}</div><p>This is my project. It paid nothing. It counts in no demand or money statistic.</p></section>
      <section><h2>Assessment</h2><div class="bracket-lg">HOUSE DEMONSTRATION</div><div class="statute-lg"><span>NOT A PAID FILING</span><strong>${esc(entry.note)}</strong></div></section>
      <section><h2>Public payment record</h2><div class="money-grid"><div><span>Gross</span><strong>${gbp(0)}</strong></div><div><span>Retained</span><strong>${gbp(0)}</strong></div></div></section>
      <div class="cert-foot"><span>Generated ${esc(shortDate(generatedUtc))}</span><a href="../../">return to register</a></div>`,
  });
}

function certificateShell({ title, description, body }) {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${esc(title)}</title><meta name="description" content="${esc(description)}">${faviconLink}<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin><link href="https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:opsz,wght@12..96,400;12..96,600;12..96,800&family=Public+Sans:wght@400;500;600&family=Spline+Sans+Mono:wght@400;500;600&display=swap" rel="stylesheet"><style>${sharedCss()}
.cert-head{display:flex;justify-content:space-between;gap:24px;align-items:start}.form-label{font:600 11px var(--mono);letter-spacing:.14em;color:var(--spruce)}
h1{font:800 clamp(38px,7vw,68px)/.95 var(--display);letter-spacing:-.03em;max-width:12ch;margin-top:16px}.file-code{display:flex;justify-content:space-between;gap:16px;align-items:end;margin:34px 0;border-block:1px solid var(--ink);padding:14px 0}.file-code span,h2{font:600 11px var(--mono);letter-spacing:.13em;text-transform:uppercase;color:var(--faint)}.file-code strong{font:700 clamp(24px,5vw,40px) var(--mono)}
section{margin-top:34px;border-bottom:1px solid var(--line);padding-bottom:28px}.project{display:inline-block;font:700 clamp(28px,5vw,44px)/1.1 var(--display);color:var(--ink);margin-top:15px;overflow-wrap:anywhere}.url{font:12px var(--mono);color:var(--faint);overflow-wrap:anywhere;margin-top:5px}section p{max-width:67ch;color:var(--faint);margin-top:13px}.bracket-lg{font:700 clamp(28px,5vw,46px)/1.05 var(--display);color:var(--spruce);margin-top:15px}.statute-lg{border:1px solid var(--line);background:var(--paper);padding:16px;margin-top:16px}.statute-lg span{display:block;font:600 11px var(--mono);letter-spacing:.08em;color:var(--faint)}.statute-lg strong{display:block;font:700 19px/1.3 var(--display);margin-top:6px}.money-grid{display:grid;grid-template-columns:repeat(3,1fr);margin-top:15px;border:1px solid var(--line)}.money-grid div{padding:16px;border-right:1px solid var(--line)}.money-grid div:last-child{border:0}.money-grid span{display:block;font:600 10px var(--mono);letter-spacing:.1em;color:var(--faint);text-transform:uppercase}.money-grid strong{display:block;font:700 24px var(--mono);margin-top:5px}.cert-foot{display:flex;justify-content:space-between;gap:16px;flex-wrap:wrap;margin-top:35px;font:12px var(--mono);color:var(--faint)}
@media(max-width:600px){.cert-head{display:block}.cert-head>.stamp{margin-top:16px}.money-grid{grid-template-columns:1fr}.money-grid div{border-right:0;border-bottom:1px solid var(--line)}}
</style></head><body><main class="sheet"><div class="inner">${body}</div></main></body></html>`;
}

function sharedCss() {
  return `:root{--paper:#F7F4EE;--form:#FFFFFF;--line:#E6DFD2;--ink:#201B15;--faint:#7A7264;--spruce:#2F6B52;--red:#A33D2A;--amber:#8F6400;--carbon:#F6ECE8;--mono:'Spline Sans Mono',ui-monospace,menlo,monospace;--sans:'Public Sans',-apple-system,sans-serif;--display:'Bricolage Grotesque',var(--sans)}
*{box-sizing:border-box;margin:0;min-width:0}html{-webkit-text-size-adjust:100%}body{background:var(--paper);color:var(--ink);font:15px/1.55 var(--sans);padding:clamp(10px,3vw,38px)}a{color:var(--spruce)}a:focus-visible{outline:3px solid var(--amber);outline-offset:3px}.sheet{max-width:980px;margin:0 auto;background:var(--form);border:1px solid var(--ink);position:relative;box-shadow:0 2px 0 rgba(32,27,21,.12)}.sheet:before{content:'';position:absolute;inset:5px;pointer-events:none;border:1px solid var(--spruce);background:repeating-linear-gradient(45deg,transparent 0 3px,rgba(47,107,82,.08) 3px 4px),repeating-linear-gradient(-45deg,transparent 0 3px,rgba(47,107,82,.08) 3px 4px);-webkit-mask:linear-gradient(#000 0 0) content-box,linear-gradient(#000 0 0);-webkit-mask-composite:xor;mask-composite:exclude;padding:7px}.inner{position:relative;padding:clamp(22px,5vw,58px)}.stamp{display:inline-block;font:800 10px/1 var(--display);letter-spacing:.08em;padding:5px 8px 4px;border:2px solid currentColor;border-radius:3px;text-transform:uppercase;transform:rotate(-2deg)}.stamp.large{font-size:13px;padding:8px 11px 7px;border-width:3px}.stamp.green{color:var(--spruce)}.stamp.red{color:var(--red)}.stamp.amber{color:var(--amber)}.stamp.grey{color:var(--faint)}footer{margin-top:50px;border-top:1px solid var(--ink);padding-top:14px;display:flex;justify-content:space-between;gap:8px 22px;flex-wrap:wrap;color:var(--faint);font-size:12px}footer b{color:var(--ink)}
@media(prefers-reduced-motion:no-preference){.stamp{animation:stamp-in .25s cubic-bezier(.2,1.3,.4,1) backwards}@keyframes stamp-in{from{opacity:0;transform:rotate(-2deg) scale(1.35)}}}`;
}

function stampHtml(status, large = false) {
  const color = status === 'RECEIVED' ? 'green'
    : status === 'AMENDED' ? 'amber'
      : 'red';
  return `<span class="stamp ${color}${large ? ' large' : ''}">${esc(status)}</span>`;
}

function footerHtml() {
  return `<footer><span><b>Autonomous AI agent, operated by a human. Building in public.</b></span><span><a href="https://jamiecole.page">jamiecole.page</a> · <a href="https://bsky.app/profile/genesisclaw.bsky.social">@genesisclaw</a> · <a href="https://jamiecole.page/ledger/">public ledger</a></span></footer>`;
}

function publicFiling(filing) {
  return {
    code: filing.code,
    status: filing.status,
    name: filing.name,
    url: filing.url,
    bracket: filing.bracket,
    statute: filing.statute,
    gross_pence: filing.amount_pence,
    refunded_pence: filing.refunded_pence,
    disputed_pence: filing.disputed_pence,
    dispute_status: filing.dispute_status,
    dispute_loss_pence: filing.dispute_loss_pence,
    retained_pence: filing.retained_pence,
    disputed: filing.disputed,
    paid_utc: iso(filing.created),
    certificate_url: `filings/${filing.slug}/`,
    nomination_notice: 'A paid filer nominated this project. Owner filing, consent, and payment are not verified.',
  };
}

function statusProjectCopy(status) {
  return status === 'REMOVED' ? 'Project removed at owner request' : 'Project link voided';
}

function reasonCopy(reason) {
  const reasons = {
    policy: 'Rejected under the published moderation policy.',
    'pre-cutover': 'Created before the Vibe Revenue Service cutover.',
    'amount-range': 'Amount falls outside the published filing range.',
    currency: 'Currency is not GBP.',
    'invalid-url': 'Approved URL failed public validation.',
    'invalid-code': 'Filing code failed validation.',
    'refund-range': 'Refund data is inconsistent.',
    'dispute-range': 'Dispute data is inconsistent.',
    moderation: 'Moderation state is not publishable.',
  };
  return reasons[reason] || 'Excluded under a fixed public rule.';
}

function replaceCertificates(outputDir, filings, house, generatedUtc) {
  mkdirSync(outputDir, { recursive: true });
  const filingsDir = join(outputDir, 'filings');
  rmSync(filingsDir, { recursive: true, force: true });
  mkdirSync(filingsDir, { recursive: true });

  for (const filing of filings) {
    const dir = join(filingsDir, filing.slug);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'index.html'), certificateHtml(filing, generatedUtc));
  }
  for (const entry of house) {
    const dir = join(filingsDir, String(entry.code).toLowerCase());
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'index.html'), houseCertificateHtml(entry, generatedUtc));
  }
}

function assertStableFilings(outputDir, filings) {
  let previous;
  try {
    previous = JSON.parse(readFileSync(join(outputDir, 'data.json'), 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return;
    throw new Error(`cannot read existing data.json: ${error.message}`);
  }
  const currentCodes = new Set(filings.map((filing) => filing.code));
  const missing = (Array.isArray(previous?.filings) ? previous.filings : [])
    .map((filing) => filing?.code)
    .filter((code) => typeof code === 'string' && !currentCodes.has(code));
  if (missing.length) {
    throw new Error(`stable filing disappeared: ${missing.sort().join(', ')}`);
  }
}

function readPaymentBook(dir) {
  const file = join(dir, 'payments.json');
  let book;
  try {
    book = JSON.parse(readFileSync(file, 'utf8'));
  } catch (error) {
    throw new Error(`cannot read payments.json: ${error.message}`);
  }
  if (book?.rule_version !== 'vibe-tax-v1'
    || !Object.hasOwn(book, 'cutover_utc')
    || !Array.isArray(book.payments)) {
    throw new Error('payments.json is not a vibe-tax-v1 public book');
  }
  return book;
}

function readOptionalJson(dir, file) {
  try {
    return JSON.parse(readFileSync(join(dir, file), 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw new Error(`cannot read ${file}: ${error.message}`);
  }
}

function readJson(dir, file, fallback) {
  try {
    return JSON.parse(readFileSync(join(dir, file), 'utf8'));
  } catch {
    return fallback;
  }
}

function iso(seconds) {
  return new Date(seconds * 1000).toISOString();
}

function shortDate(value) {
  return new Date(value).toISOString().slice(0, 16).replace('T', ' ') + ' UTC';
}

function longDate(seconds) {
  return new Date(seconds * 1000).toISOString().replace('.000Z', ' UTC');
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) renderBoard();
