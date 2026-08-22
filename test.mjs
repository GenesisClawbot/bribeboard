import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeUrl,
  sanitizeName,
  filingCode,
  taxBracket,
  buildRegister,
  gbp,
  median,
  escapeHtml,
} from './lib.mjs';

test('normalizeUrl adds https and preserves the nominated host', () => {
  const withWww = normalizeUrl('www.Example.com/My-App');
  const withoutWww = normalizeUrl('example.com/My-App');

  assert.equal(withWww.ok, true);
  assert.equal(withWww.display, 'https://www.example.com/My-App');
  assert.equal(withWww.identity, 'https://www.example.com/My-App');
  assert.notEqual(withWww.identity, withoutWww.identity);
});

test('normalizeUrl preserves the nominated origin, port, and path case', () => {
  const http = normalizeUrl('http://Example.com:8080/App');
  const upper = normalizeUrl('https://example.com/App');
  const lower = normalizeUrl('https://example.com/app');

  assert.deepEqual(http, {
    ok: true,
    identity: 'http://example.com:8080/App',
    display: 'http://example.com:8080/App',
  });
  assert.notEqual(upper.identity, lower.identity);
});

test('normalizeUrl strips trailing slash and hash', () => {
  const r = normalizeUrl('https://foo.dev/app/#top');
  assert.equal(r.display, 'https://foo.dev/app');
});

test('normalizeUrl strips tracking params, keeps real ones', () => {
  const r = normalizeUrl('https://foo.dev/a?utm_source=x&ref=y&id=3&affiliate=z&fbclid=1');
  assert.equal(r.display, 'https://foo.dev/a?id=3');
});

test('normalizeUrl strips common recipient and click identifiers', () => {
  const r = normalizeUrl('https://foo.dev/a?id=3&mc_cid=mail&_ga=client&msclkid=click&igshid=social&referral=partner-abc&partner_id=affiliate-7');
  assert.equal(r.display, 'https://foo.dev/a?id=3');
});

test('normalizeUrl includes canonical real query params in identity', () => {
  const alpha = normalizeUrl('https://foo.dev/app?view=grid&id=alpha');
  const reordered = normalizeUrl('https://foo.dev/app?id=alpha&view=grid');
  const beta = normalizeUrl('https://foo.dev/app?id=beta&view=grid');

  assert.equal(alpha.identity, reordered.identity);
  assert.equal(alpha.display, 'https://foo.dev/app?id=alpha&view=grid');
  assert.notEqual(alpha.identity, beta.identity);
});

test('normalizeUrl rejects shorteners', () => {
  assert.equal(normalizeUrl('https://bit.ly/abc').reason, 'shortener');
});

test('normalizeUrl rejects www aliases of prohibited hosts', () => {
  assert.equal(normalizeUrl('https://www.bit.ly/abc').reason, 'shortener');
  assert.equal(
    normalizeUrl('https://www.discord.com/invite/abc').reason,
    'invite-link',
  );
});

test('normalizeUrl rejects invite links', () => {
  assert.equal(normalizeUrl('https://discord.gg/abc').reason, 'invite-link');
  assert.equal(normalizeUrl('https://discord.com/invite/abc').reason, 'invite-link');
  assert.equal(normalizeUrl('https://t.me/abc').reason, 'invite-link');
});

test('normalizeUrl rejects junk', () => {
  assert.equal(normalizeUrl('').ok, false);
  assert.equal(normalizeUrl('not a url at all £$%').ok, false);
  assert.equal(normalizeUrl('localhost').reason, 'no-tld');
  assert.equal(normalizeUrl('ftp://foo.com').ok, false);
});

test('sanitizeName strips control chars and caps length', () => {
  assert.equal(sanitizeName('my\x00app\x1f name'), 'myapp name');
  assert.equal(sanitizeName('x'.repeat(100)).length, 60);
  assert.equal(sanitizeName(null), '');
});

test('filingCode is stable and opaque', () => {
  assert.equal(filingCode('cs_test_one'), filingCode('cs_test_one'));
  assert.match(filingCode('cs_test_one'), /^V-[A-F0-9]{32}$/);
  assert.notEqual(filingCode('cs_test_one'), filingCode('cs_test_two'));
  assert.doesNotMatch(filingCode('cs_test_one'), /TEST|ONE/i);
});

test('taxBracket covers every exact boundary', () => {
  const cases = [
    [99, null],
    [100, 'MICRO ENTITY'],
    [499, 'MICRO ENTITY'],
    [500, 'SIDE PROJECT IN TRADE'],
    [1999, 'SIDE PROJECT IN TRADE'],
    [2000, 'REVENUE-ADJACENT BODY'],
    [9999, 'REVENUE-ADJACENT BODY'],
    [10000, 'VIBE CORPORATION'],
    [49999, 'VIBE CORPORATION'],
    [50000, 'SYSTEMIC VIBE CONCERN'],
    [499999, 'SYSTEMIC VIBE CONCERN'],
    [500000, 'TOO VIBE TO FAIL'],
    [500001, null],
  ];
  for (const [amount, title] of cases) {
    assert.equal(taxBracket(amount)?.title || null, title, String(amount));
  }
});

test('buildRegister sorts by creation time then filing code', () => {
  const { filings } = buildRegister([
    approved({ code: 'V-BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB', created: 2, url: 'beta.dev' }),
    approved({ code: 'V-CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC', created: 1, url: 'charlie.dev' }),
    approved({ code: 'V-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', created: 1, url: 'alpha.dev' }),
  ]);
  assert.deepEqual(filings.map((f) => f.code), [
    'V-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
    'V-CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC',
    'V-BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB',
  ]);
});

test('buildRegister rejects a duplicate filing code', () => {
  const payment = approved({
    code: 'V-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
    url: 'alpha.dev',
  });

  assert.throws(
    () => buildRegister([payment, { ...payment }]),
    /duplicate filing code/,
  );
});

test('buildRegister assigns a stable published fictional statute', () => {
  const payment = approved({ code: 'V-1234ABCD1234ABCD1234ABCD1234ABCD', url: 'alpha.dev' });
  const first = buildRegister([payment]).filings[0];
  const second = buildRegister([payment]).filings[0];
  assert.deepEqual(first.statute, second.statute);
  assert.match(first.statute.code, /^SECTION /);
  assert.ok(first.statute.title.length > 0);
  assert.equal(first.statute.fictional, true);
});

test('buildRegister reports amendments, voids, removals, and totals', () => {
  const result = buildRegister([
    approved({ code: 'V-11111111111111111111111111111111', amount: 2000, refunded: 0, url: 'same.dev', created: 1 }),
    approved({ code: 'V-22222222222222222222222222222222', amount: 500, refunded: 100, url: 'same.dev', created: 2 }),
    approved({ code: 'V-33333333333333333333333333333333', amount: 700, refunded: 700, url: 'gone.dev', created: 3 }),
    approved({ code: 'V-44444444444444444444444444444444', amount: 900, disputedPence: 300, url: 'disputed.dev', created: 4 }),
    { filing_code: 'V-55555555555555555555555555555555', amount: 1000, refunded: 0, disputed: false,
      currency: 'gbp', created: 5, moderation: 'removed' },
  ]);

  assert.deepEqual(result.filings.map((f) => f.status), [
    'RECEIVED', 'AMENDED', 'VOID', 'VOID', 'REMOVED',
  ]);
  assert.deepEqual(result.totals, {
    gross_pence: 5100,
    refunded_pence: 800,
    disputed_pence: 300,
    retained_pence: 4000,
    valid_retained_pence: 2400,
    certificate_count: 5,
    filing_count: 2,
    distinct_project_count: 1,
  });
  assert.equal(result.filings[4].url, null);
  assert.equal(result.filings[4].name, null);
  assert.equal(result.filings[4].retained_pence, 1000);
});

test('buildRegister keeps pending private and books fixed exclusions', () => {
  const result = buildRegister([
    { filing_code: 'V-11111111111111111111111111111111', amount: 100, currency: 'gbp', created: 1,
      moderation: 'pending' },
    { filing_code: 'V-22222222222222222222222222222222', amount: 100, currency: 'gbp', created: 2,
      moderation: 'rejected', reason: 'policy' },
    { filing_code: 'V-33333333333333333333333333333333', amount: 100, currency: 'gbp', created: 3,
      moderation: 'legacy' },
    approved({ code: 'V-44444444444444444444444444444444', amount: 99, url: 'cheap.dev', created: 4 }),
    approved({ code: 'V-55555555555555555555555555555555', currency: 'usd', url: 'dollars.dev', created: 5 }),
  ]);

  assert.deepEqual(result.pending.map((p) => p.code), ['V-11111111111111111111111111111111']);
  assert.deepEqual(result.excluded.map((e) => e.reason), [
    'policy', 'pre-cutover', 'amount-range', 'currency',
  ]);
});

test('buildRegister rejects fractional refund and dispute minor units', () => {
  const result = buildRegister([
    approved({
      code: 'V-11111111111111111111111111111111',
      refunded: 0.5,
      url: 'refund.dev',
    }),
    approved({
      code: 'V-22222222222222222222222222222222',
      disputedPence: 0.5,
      disputeLossPence: 0.5,
      url: 'dispute.dev',
    }),
  ]);

  assert.deepEqual(result.excluded.map((entry) => entry.reason), [
    'refund-range',
    'dispute-range',
  ]);
  assert.equal(result.filings.length, 0);
});

test('buildRegister includes pending and rejected GBP in actual money totals', () => {
  const result = buildRegister([
    { filing_code: 'V-11111111111111111111111111111111', amount: 500, refunded: 0, currency: 'gbp',
      created: 1, moderation: 'pending' },
    { filing_code: 'V-22222222222222222222222222222222', amount: 700, refunded: 100, currency: 'gbp',
      created: 2, moderation: 'rejected', reason: 'policy' },
    { filing_code: 'V-33333333333333333333333333333333', amount: 900, refunded: 0, currency: 'gbp',
      created: 3, moderation: 'legacy' },
  ]);

  assert.deepEqual(result.totals, {
    gross_pence: 1200,
    refunded_pence: 100,
    disputed_pence: 0,
    retained_pence: 1100,
    valid_retained_pence: 0,
    certificate_count: 0,
    filing_count: 0,
    distinct_project_count: 0,
  });
});

test('buildRegister represents dispute reversals and refund overlap', () => {
  const lost = buildRegister([approved({
    code: 'V-11111111111111111111111111111111', amount: 500, refunded: 100,
    disputedPence: 500, disputeStatus: 'lost', disputeLossPence: 500,
  })]);
  const won = buildRegister([approved({
    code: 'V-22222222222222222222222222222222', amount: 500, refunded: 100,
    disputedPence: 500, disputeStatus: 'won', disputeLossPence: 0,
  })]);

  assert.equal(lost.excluded.length, 0);
  assert.equal(lost.filings[0].status, 'VOID');
  assert.equal(lost.totals.retained_pence, 0);
  assert.equal(lost.totals.refunded_pence, 100);
  assert.equal(lost.totals.disputed_pence, 500);
  assert.equal(won.filings[0].status, 'VOID');
  assert.equal(won.totals.retained_pence, 400);
  assert.equal(won.totals.valid_retained_pence, 0);
});

test('gbp formats pence', () => {
  assert.equal(gbp(100), '£1.00');
  assert.equal(gbp(103307), '£1,033.07');
});

test('median handles even and odd and empty', () => {
  assert.equal(median([]), 0);
  assert.equal(median([100, 300, 200]), 200);
  assert.equal(median([100, 200, 300, 400]), 250);
});

test('escapeHtml escapes the five', () => {
  assert.equal(escapeHtml(`<a href="x">&'`), '&lt;a href=&quot;x&quot;&gt;&amp;&#39;');
});

function approved({
  code,
  amount = 100,
  refunded = 0,
  disputedPence = 0,
  disputeStatus = disputedPence > 0 ? 'needs_response' : null,
  disputeLossPence = disputedPence,
  currency = 'gbp',
  created = 1,
  url = 'example.dev',
  name = 'Example',
}) {
  return {
    filing_code: code,
    amount,
    refunded,
    disputed: disputedPence > 0,
    disputed_pence: disputedPence,
    dispute_status: disputeStatus,
    dispute_loss_pence: disputeLossPence,
    currency,
    created,
    moderation: 'approved',
    url,
    name,
  };
}
