import test from 'node:test';
import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { renderBoard } from './render.mjs';

test('renderBoard writes a chronological register and stable safe certificates', (t) => {
  const root = fixture(t, { windowOpen: false, cutoverUtc: null });
  const stale = join(root.output, 'filings', 'stale', 'index.html');
  mkdirSync(join(root.output, 'filings', 'stale'), { recursive: true });
  writeFileSync(stale, 'unsafe stale link');

  const summary = renderBoard({
    sourceDir: root.source,
    outputDir: root.output,
    generatedUtc: '2026-08-21T16:30:00.000Z',
  });
  const index = text(join(root.output, 'index.html'));
  const data = JSON.parse(text(join(root.output, 'data.json')));
  const certificatePath = join(root.output, 'filings', 'v-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'index.html');
  const certificate = text(certificatePath);

  assert.deepEqual(summary, {
    filings: 4,
    pending: 1,
    excluded: 1,
    retained_pence: 2037,
    window_open: false,
  });
  assert.match(index, /VIBE REVENUE SERVICE/);
  assert.doesNotMatch(index, /[ \t]+$/m);
  assert.doesNotMatch(index, /\brank(?:ed|ing)?\b/i);
  assert.match(index, /V-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA[\s\S]*V-BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB/);
  assert.match(index, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.doesNotMatch(index, /buy\.stripe\.com/);
  assert.equal(existsSync(certificatePath), true);
  assert.equal(existsSync(stale), false);
  assert.match(certificate, /A paid filer nominated this project\./);
  assert.match(certificate, /FICTIONAL STATUTE/);
  assert.match(certificate, /This is satire, not a factual finding\./);
  assert.match(certificate, /rel="nofollow noopener"/);
  assert.match(certificate, /rel="icon" href="data:image\/svg\+xml/);
  assert.equal(data.filings[0].code, 'V-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA');
  assert.equal(data.window_open, false);
  assert.equal(data.totals.valid_retained_pence, 1737);
  assert.equal('payments' in data, false);
  assert.doesNotMatch(
    JSON.stringify(data),
    /Must stay private|removed\.example|Pending secret|pending\.example|Rejected secret|rejected\.example/,
  );
  assert.equal(data.house.every((entry) => entry.paid_pence === 0), true);
});

test('renderBoard emits clean output when the exclusion book is empty', (t) => {
  const root = fixture(t, { windowOpen: false, cutoverUtc: null });
  writeJson(join(root.source, 'payments.json'), {
    rule_version: 'vibe-tax-v1',
    cutover_utc: null,
    pulled_utc: '2026-08-21T16:29:00.000Z',
    payments: [],
  });

  renderBoard({
    sourceDir: root.source,
    outputDir: root.output,
    generatedUtc: '2026-08-21T16:30:00.000Z',
  });

  assert.doesNotMatch(text(join(root.output, 'index.html')), /[ \t]+$/m);
});

test('renderBoard gives void and removed certificates no project link', (t) => {
  const root = fixture(t, { windowOpen: false, cutoverUtc: null });
  renderBoard({
    sourceDir: root.source,
    outputDir: root.output,
    generatedUtc: '2026-08-21T16:30:00.000Z',
  });

  const voided = text(join(root.output, 'filings', 'v-cccccccccccccccccccccccccccccccc', 'index.html'));
  const removed = text(join(root.output, 'filings', 'v-dddddddddddddddddddddddddddddddd', 'index.html'));
  assert.doesNotMatch(voided, /href="https:\/\/void\.example/);
  assert.match(voided, /VOID/);
  assert.match(voided, /Disputed[\s\S]*£1\.00/);
  assert.match(voided, /Dispute status[\s\S]*lost/i);
  const data = JSON.parse(text(join(root.output, 'data.json')));
  const disputed = data.filings.find((filing) => filing.code === 'V-CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC');
  assert.equal(disputed.disputed_pence, 100);
  assert.equal(disputed.dispute_status, 'lost');
  assert.equal(disputed.dispute_loss_pence, 100);
  assert.doesNotMatch(removed, /removed\.example|nofollow noopener/);
  assert.match(removed, /REMOVED/);
});

test('renderBoard explains inconsistent dispute data', (t) => {
  const root = fixture(t, { windowOpen: false, cutoverUtc: null });
  writeJson(join(root.source, 'payments.json'), {
    rule_version: 'vibe-tax-v1',
    cutover_utc: null,
    pulled_utc: '2026-08-21T16:29:00.000Z',
    payments: [{
      filing_code: 'V-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
      amount: 100,
      refunded: 0,
      disputed: true,
      disputed_pence: 200,
      currency: 'gbp',
      created: 1,
      moderation: 'approved',
      name: 'Invalid',
      url: 'invalid.example',
    }],
  });

  renderBoard({
    sourceDir: root.source,
    outputDir: root.output,
    generatedUtc: '2026-08-21T16:30:00.000Z',
  });

  assert.match(
    text(join(root.output, 'index.html')),
    /Dispute data is inconsistent\./,
  );
});

test('renderBoard keeps Checkout closed without a verified cutover attestation', (t) => {
  const cutoverUtc = '2026-08-21T16:00:00.000Z';
  const root = fixture(t, { windowOpen: true, cutoverUtc });
  rmSync(join(root.source, 'stripe-cutover.json'), { force: true });

  renderBoard({
    sourceDir: root.source,
    outputDir: root.output,
    generatedUtc: '2026-08-21T16:30:00.000Z',
  });

  const index = text(join(root.output, 'index.html'));
  assert.doesNotMatch(index, /buy\.stripe\.com/);
  assert.match(index, /DESK CLOSED FOR REFIT/);
});

test('renderBoard replaces stale open output with closed output on attestation mismatch', (t) => {
  const cutoverUtc = '2026-08-21T16:00:00.000Z';
  const root = fixture(t, { windowOpen: true, cutoverUtc });

  renderBoard({
    sourceDir: root.source,
    outputDir: root.output,
    generatedUtc: '2026-08-21T16:30:00.000Z',
  });
  assert.match(text(join(root.output, 'index.html')), /OPEN FOR FILINGS/);

  const receiptPath = join(root.source, 'stripe-cutover.json');
  const receipt = JSON.parse(text(receiptPath));
  receipt.payment_link.url = 'https://buy.stripe.com/wrong';
  writeJson(receiptPath, receipt);

  assert.throws(
    () => renderBoard({
      sourceDir: root.source,
      outputDir: root.output,
      generatedUtc: '2026-08-21T16:31:00.000Z',
    }),
    /cutover attestation mismatch/,
  );

  const index = text(join(root.output, 'index.html'));
  assert.match(index, /DESK CLOSED FOR REFIT/);
  assert.doesNotMatch(index, /buy\.stripe\.com/);
});

test('renderBoard replaces removed certificates before reporting attestation drift', (t) => {
  const cutoverUtc = '2026-08-21T16:00:00.000Z';
  const root = fixture(t, { windowOpen: true, cutoverUtc });

  renderBoard({
    sourceDir: root.source,
    outputDir: root.output,
    generatedUtc: '2026-08-21T16:30:00.000Z',
  });
  const certificate = join(root.output, 'filings', 'v-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'index.html');
  assert.match(text(certificate), /alpha\.example/);

  const bookPath = join(root.source, 'payments.json');
  const book = JSON.parse(text(bookPath));
  book.payments.find(({ filing_code: code }) => code === 'V-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA').moderation = 'removed';
  writeJson(bookPath, book);
  const receiptPath = join(root.source, 'stripe-cutover.json');
  const receipt = JSON.parse(text(receiptPath));
  receipt.payment_link.url = 'https://buy.stripe.com/wrong';
  writeJson(receiptPath, receipt);

  assert.throws(
    () => renderBoard({
      sourceDir: root.source,
      outputDir: root.output,
      generatedUtc: '2026-08-21T16:31:00.000Z',
    }),
    /cutover attestation mismatch/,
  );

  const removed = text(certificate);
  assert.match(removed, /REMOVED/);
  assert.doesNotMatch(removed, /alpha\.example|script>alert/);
});

test('renderBoard exposes checkout only when both open gates pass', (t) => {
  for (const [windowOpen, cutoverUtc, shouldOpen] of [
    [false, null, false],
    [true, null, false],
    [false, '2026-08-21T16:00:00.000Z', false],
    [true, '2026-08-21T16:00:00.000Z', true],
  ]) {
    const root = fixture(t, { windowOpen, cutoverUtc });
    renderBoard({
      sourceDir: root.source,
      outputDir: root.output,
      generatedUtc: '2026-08-21T16:30:00.000Z',
    });
    const index = text(join(root.output, 'index.html'));
    assert.equal(index.includes('https://buy.stripe.com/test'), shouldOpen,
      `${windowOpen}/${cutoverUtc}`);
  }
});

test('renderBoard keeps checkout closed when configured cutover differs from receipt and book', (t) => {
  const cutoverUtc = '2026-08-21T16:00:00.000Z';
  const root = fixture(t, { windowOpen: true, cutoverUtc });
  const configPath = join(root.source, 'board-config.json');
  const config = JSON.parse(text(configPath));
  config.cutover_utc = '2026-08-21T16:00:01.000Z';
  writeJson(configPath, config);

  renderBoard({
    sourceDir: root.source,
    outputDir: root.output,
    generatedUtc: '2026-08-21T16:30:00.000Z',
  });

  const index = text(join(root.output, 'index.html'));
  assert.match(index, /DESK CLOSED FOR REFIT/);
  assert.doesNotMatch(index, /buy\.stripe\.com/);
});

test('renderBoard fixes card area and clamps long register names', (t) => {
  const root = fixture(t, { windowOpen: false, cutoverUtc: null });

  renderBoard({
    sourceDir: root.source,
    outputDir: root.output,
    generatedUtc: '2026-08-21T16:30:00.000Z',
  });

  const index = text(join(root.output, 'index.html'));
  assert.match(index, /\.filing-card\{[^}]*height:280px/);
  assert.match(index, /\.filing-card h3\{[^}]*-webkit-line-clamp:3/);
});

test('renderBoard preserves stable pages when the payment book is missing', (t) => {
  const root = fixture(t, { windowOpen: false, cutoverUtc: null });
  const stable = join(root.output, 'filings', 'v-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'index.html');
  mkdirSync(join(root.output, 'filings', 'v-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'), { recursive: true });
  writeFileSync(stable, 'existing stable certificate');
  rmSync(join(root.source, 'payments.json'));

  assert.throws(
    () => renderBoard({
      sourceDir: root.source,
      outputDir: root.output,
      generatedUtc: '2026-08-21T16:30:00.000Z',
    }),
    /payments\.json/,
  );
  assert.equal(text(stable), 'existing stable certificate');
});

test('renderBoard preserves stable pages when the payment book drops a filing', (t) => {
  const root = fixture(t, { windowOpen: false, cutoverUtc: null });
  renderBoard({
    sourceDir: root.source,
    outputDir: root.output,
    generatedUtc: '2026-08-21T16:30:00.000Z',
  });
  const stable = join(root.output, 'filings', 'v-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'index.html');
  const before = text(stable);
  writeJson(join(root.source, 'payments.json'), {
    rule_version: 'vibe-tax-v1',
    cutover_utc: null,
    pulled_utc: '2026-08-21T16:31:00.000Z',
    payments: [],
  });

  assert.throws(
    () => renderBoard({
      sourceDir: root.source,
      outputDir: root.output,
      generatedUtc: '2026-08-21T16:32:00.000Z',
    }),
    /stable filing disappeared: V-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA/,
  );
  assert.equal(text(stable), before);
});

function fixture(t, { windowOpen, cutoverUtc }) {
  const parent = mkdtempSync(join(tmpdir(), 'vibe-tax-render-'));
  t.after(() => rmSync(parent, { recursive: true, force: true }));
  const source = join(parent, 'source');
  const output = join(parent, 'output');
  mkdirSync(source);
  writeJson(join(source, 'board-config.json'), {
    payment_link_id: 'plink_test',
    payment_link_url: 'https://buy.stripe.com/test',
    product_id: 'prod_test',
    price_id: 'price_test',
    window_open: windowOpen,
    cutover_utc: cutoverUtc,
    currency: 'gbp',
    minimum_pence: 100,
    maximum_pence: 500000,
  });
  if (cutoverUtc) {
    writeJson(join(source, 'stripe-cutover.json'), validAttestation(cutoverUtc));
  }
  writeJson(join(source, 'payments.json'), {
    rule_version: 'vibe-tax-v1',
    cutover_utc: cutoverUtc,
    pulled_utc: '2026-08-21T16:29:00.000Z',
    payments: [
      approved({
        code: 'V-BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB', created: 2, amount: 500, refunded: 100,
        name: 'Beta', url: 'beta.example',
      }),
      approved({
        code: 'V-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', created: 1, amount: 1337,
        name: '<script>alert(1)</script>', url: 'alpha.example',
      }),
      approved({
        code: 'V-CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC', created: 3, amount: 200, refunded: 100,
        disputedPence: 100, disputeStatus: 'lost', disputeLossPence: 100,
        name: 'Void', url: 'void.example',
      }),
      {
        filing_code: 'V-DDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDD', created: 4, amount: 100, refunded: 0,
        disputed: false, currency: 'gbp', moderation: 'removed',
        name: 'Must stay private', url: 'removed.example',
      },
      {
        filing_code: 'V-EEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEE', created: 5, amount: 100, refunded: 0,
        disputed: false, currency: 'gbp', moderation: 'pending',
        name: 'Pending secret', url: 'pending.example',
      },
      {
        filing_code: 'V-FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF', created: 6, amount: 100, refunded: 0,
        disputed: false, currency: 'gbp', moderation: 'rejected', reason: 'policy',
        name: 'Rejected secret', url: 'rejected.example',
      },
    ],
  });
  writeJson(join(source, 'house.json'), [{
    code: 'H-001',
    name: 'burnboard',
    url: 'https://jamiecole.page/burnboard/',
    note: 'House example. It paid nothing.',
  }]);
  return { source, output };
}

function validAttestation(cutoverUtc) {
  return {
    verified: true,
    cutover_utc: cutoverUtc,
    stripe_api_version: '2026-07-29.dahlia',
    payment_link_id: 'plink_test',
    product_id: 'prod_test',
    price_id: 'price_test',
    product: {
      id: 'prod_test',
      name: 'Bribeboard Vibe Tax Filing',
      description: 'One moderated public comic tax filing for a nominated side project. Does not buy rank, traffic, owner verification, endorsement, or a review.',
    },
    payment_link: {
      id: 'plink_test',
      url: 'https://buy.stripe.com/test',
      active: true,
      completion_message: 'Payment received. Your filing is pending manual moderation. Publication normally takes about one hour during 08:30 to 23:30 London. Save this page for your receipt.',
      custom_field_keys: ['project_name', 'project_url'],
      currency: 'gbp',
      minimum_pence: 100,
      maximum_pence: 500000,
    },
  };
}

function approved({
  code,
  created,
  amount,
  refunded = 0,
  disputedPence = 0,
  disputeStatus = disputedPence > 0 ? 'needs_response' : null,
  disputeLossPence = disputedPence,
  name,
  url,
}) {
  return {
    filing_code: code,
    amount,
    refunded,
    disputed: disputedPence > 0,
    disputed_pence: disputedPence,
    dispute_status: disputeStatus,
    dispute_loss_pence: disputeLossPence,
    currency: 'gbp',
    created,
    created_utc: new Date(created * 1000).toISOString(),
    moderation: 'approved',
    name,
    url,
  };
}

function writeJson(path, value) {
  writeFileSync(path, JSON.stringify(value, null, 2) + '\n');
}

function text(path) {
  return readFileSync(path, 'utf8');
}
