import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  toPublicPayment,
  buildPublicBook,
  buildModerationInbox,
  cutoverUnixFromAttestation,
} from './poll.mjs';
import { filingCode } from './lib.mjs';

test('toPublicPayment publishes only approved moderator strings', () => {
  const session = paidSession({
    id: 'cs_approved',
    name: 'raw private name',
    url: 'https://raw-private.example',
  });
  const record = toPublicPayment(session, {
    status: 'approved',
    name: 'Approved Project',
    url: 'https://approved.example/?utm_source=private',
  }, 50);

  assert.deepEqual(record, {
    filing_code: filingCode('cs_approved'),
    amount: 1337,
    refunded: 0,
    disputed: false,
    disputed_pence: 0,
    dispute_status: null,
    dispute_loss_pence: 0,
    currency: 'gbp',
    created: 100,
    created_utc: '1970-01-01T00:01:40.000Z',
    moderation: 'approved',
    name: 'Approved Project',
    url: 'https://approved.example',
  });
  assert.doesNotMatch(JSON.stringify(record), /raw private|raw-private/);
});

test('toPublicPayment redacts pending, rejected, and removed submissions', () => {
  const session = paidSession({ name: 'private project', url: 'https://private.example' });
  const decisions = [
    undefined,
    { status: 'rejected', reason: 'policy' },
    { status: 'removed' },
  ];

  for (const decision of decisions) {
    const record = toPublicPayment(session, decision, 50);
    const serialized = JSON.stringify(record);
    assert.doesNotMatch(serialized, /private project|private\.example/);
    assert.equal('name' in record, false);
    assert.equal('url' in record, false);
  }
  assert.equal(toPublicPayment(session, undefined, 50).moderation, 'pending');
  assert.equal(toPublicPayment(session, decisions[1], 50).reason, 'policy');
  assert.equal(toPublicPayment(session, decisions[2], 50).moderation, 'removed');
});

test('toPublicPayment marks sessions before the cutover as legacy', () => {
  const record = toPublicPayment(
    paidSession({ created: 99, name: 'old name', url: 'https://old.example' }),
    { status: 'approved', name: 'Old', url: 'https://old.example' },
    100,
  );
  assert.equal(record.moderation, 'legacy');
  assert.equal(record.reason, 'pre-cutover');
  assert.equal('name' in record, false);
  assert.equal('url' in record, false);
});

test('toPublicPayment carries exact partial refunds and disputes from the charge', () => {
  const record = toPublicPayment(
    paidSession({ refunded: 37, disputedAmount: 300, disputeStatus: 'lost' }),
    { status: 'approved', name: 'A', url: 'a.example' },
    50,
  );
  assert.equal(record.refunded, 37);
  assert.equal(record.disputed, true);
  assert.equal(record.disputed_pence, 300);
  assert.equal(record.dispute_status, 'lost');
  assert.equal(record.dispute_loss_pence, 300);
});

test('toPublicPayment uses dispute balance effects after a partial refund', () => {
  const record = toPublicPayment(
    paidSession({
      amount: 500,
      refunded: 100,
      disputedAmount: 500,
      disputeStatus: 'lost',
      disputeBalanceTransactions: [{ amount: -400, currency: 'gbp' }],
    }),
    { status: 'approved', name: 'A', url: 'a.example' },
    50,
  );

  assert.equal(record.disputed_pence, 500);
  assert.equal(record.dispute_loss_pence, 400);
});

test('toPublicPayment refuses a dispute balance effect in another currency', () => {
  assert.throws(
    () => toPublicPayment(
      paidSession({
        disputedAmount: 500,
        disputeStatus: 'lost',
        disputeBalanceTransactions: [{ amount: -500, currency: 'usd' }],
      }),
      { status: 'approved', name: 'A', url: 'a.example' },
      50,
    ),
    /dispute balance currency mismatch/,
  );
});

test('toPublicPayment records a won dispute without a current principal loss', () => {
  const record = toPublicPayment(
    paidSession({ disputedAmount: 500, disputeStatus: 'won' }),
    { status: 'approved', name: 'A', url: 'a.example' },
    50,
  );

  assert.equal(record.disputed, true);
  assert.equal(record.disputed_pence, 500);
  assert.equal(record.dispute_status, 'won');
  assert.equal(record.dispute_loss_pence, 0);
});

test('toPublicPayment gives non-chargeback disputes no current principal loss', () => {
  for (const disputeStatus of [
    'warning_needs_response',
    'warning_under_review',
    'warning_closed',
    'prevented',
  ]) {
    const record = toPublicPayment(
      paidSession({ disputedAmount: 500, disputeStatus }),
      { status: 'approved', name: 'A', url: 'a.example' },
      50,
    );

    assert.equal(record.dispute_status, disputeStatus);
    assert.equal(record.dispute_loss_pence, 0);
  }
});

test('toPublicPayment refuses an unexpanded dispute', () => {
  const session = paidSession({ disputedAmount: 300 });
  session.payment_intent.latest_charge.dispute = 'dp_test';

  assert.throws(
    () => toPublicPayment(
      session,
      { status: 'approved', name: 'A', url: 'a.example' },
      50,
    ),
    /expanded dispute details missing/,
  );
});

test('toPublicPayment refuses a paid session without an expanded charge', () => {
  const session = paidSession();
  session.payment_intent.latest_charge = 'ch_test';

  assert.throws(
    () => toPublicPayment(session, undefined, 50),
    /expanded charge details missing/,
  );
});

test('toPublicPayment ignores incomplete and unpaid sessions', () => {
  assert.equal(toPublicPayment(paidSession({ status: 'open' }), undefined, 50), null);
  assert.equal(toPublicPayment(paidSession({ paymentStatus: 'unpaid' }), undefined, 50), null);
});

test('invalid approval stays pending without publishing moderator strings', () => {
  const record = toPublicPayment(
    paidSession(),
    { status: 'approved', name: 'Bad', url: 'javascript:alert(1)' },
    50,
  );
  assert.equal(record.moderation, 'pending');
  assert.equal('name' in record, false);
  assert.equal('url' in record, false);
});

test('cutoverUnixFromAttestation ignores config timestamps and requires the receipt', () => {
  const config = {
    payment_link_id: 'plink_test',
    payment_link_url: 'https://buy.stripe.com/test',
    product_id: 'prod_test',
    price_id: 'price_test',
    cutover_utc: '2020-01-01T00:00:00.000Z',
    currency: 'gbp',
    minimum_pence: 100,
    maximum_pence: 500000,
  };

  assert.equal(cutoverUnixFromAttestation(config, null), null);
  assert.equal(
    cutoverUnixFromAttestation(config, validAttestation()),
    Date.parse('2026-08-21T17:00:00.000Z') / 1000,
  );
  assert.throws(
    () => cutoverUnixFromAttestation(
      config,
      null,
      '2026-08-21T17:00:00.000Z',
    ),
    /verified cutover receipt disappeared/,
  );
});

test('buildPublicBook is deterministic and contains no raw pending content', () => {
  const sessions = [
    paidSession({ id: 'cs_later', created: 101, name: 'secret later', url: 'later.private' }),
    paidSession({ id: 'cs_earlier', created: 100, name: 'secret earlier', url: 'earlier.private' }),
    paidSession({ id: 'cs_unpaid', created: 99, paymentStatus: 'unpaid' }),
  ];
  const book = buildPublicBook({
    sessions,
    moderation: {},
    cutoverUnix: 50,
    pulledUtc: '2026-08-21T16:00:00.000Z',
  });

  assert.equal(book.rule_version, 'vibe-tax-v1');
  assert.deepEqual(book.payments.map((p) => p.created), [100, 101]);
  assert.doesNotMatch(JSON.stringify(book), /secret|\.private/);
});

test('buildPublicBook rejects a duplicate paid Session', () => {
  const session = paidSession({ id: 'cs_duplicate' });

  assert.throws(
    () => buildPublicBook({
      sessions: [session, structuredClone(session)],
      moderation: {},
      cutoverUnix: 50,
      pulledUtc: '2026-08-21T16:00:00.000Z',
    }),
    /duplicate paid Session/,
  );
});

test('buildPublicBook rejects duplicate filing codes in the previous book', () => {
  const session = paidSession({ id: 'cs_previous_duplicate' });
  const previous = toPublicPayment(session, {
    status: 'approved', name: 'Frozen', url: 'frozen.example',
  }, 50);

  assert.throws(
    () => buildPublicBook({
      sessions: [session],
      moderation: {},
      previousPayments: [previous, { ...previous, name: 'Conflicting' }],
      cutoverUnix: 50,
      pulledUtc: '2026-08-21T16:00:00.000Z',
    }),
    /duplicate filing code in previous payment book/,
  );
});

test('buildPublicBook freezes an approved filing and permits owner removal', () => {
  const session = paidSession({ id: 'cs_frozen' });
  const code = filingCode(session.id);
  const previous = toPublicPayment(session, {
    status: 'approved', name: 'Frozen name', url: 'frozen.example',
  }, 50);

  const changed = buildPublicBook({
    sessions: [session],
    moderation: {
      [code]: { status: 'approved', name: 'Changed', url: 'changed.example' },
    },
    previousPayments: [previous],
    cutoverUnix: 50,
    pulledUtc: '2026-08-21T16:00:00.000Z',
  });
  assert.equal(changed.payments[0].name, 'Frozen name');
  assert.equal(changed.payments[0].url, 'https://frozen.example');

  const removed = buildPublicBook({
    sessions: [session],
    moderation: { [code]: { status: 'removed' } },
    previousPayments: [previous],
    cutoverUnix: 50,
    pulledUtc: '2026-08-21T16:01:00.000Z',
  });
  assert.equal(removed.payments[0].moderation, 'removed');
  assert.equal('name' in removed.payments[0], false);
  assert.equal('url' in removed.payments[0], false);
});

test('buildPublicBook rejects disappearance of a known paid session', () => {
  const session = paidSession({ id: 'cs_known' });
  const previous = toPublicPayment(session, {
    status: 'approved', name: 'Known', url: 'known.example',
  }, 50);

  assert.throws(
    () => buildPublicBook({
      sessions: [],
      moderation: {},
      previousPayments: [previous],
      cutoverUnix: 50,
      pulledUtc: '2026-08-21T16:01:00.000Z',
    }),
    /known paid Session disappeared: V-[A-F0-9]{32}/,
  );
});

test('buildPublicBook rejects an invalid terminal moderation transition', () => {
  const session = paidSession({ id: 'cs_terminal' });
  const code = filingCode(session.id);
  const previous = toPublicPayment(session, {
    status: 'approved', name: 'Frozen', url: 'frozen.example',
  }, 50);

  assert.throws(
    () => buildPublicBook({
      sessions: [session],
      moderation: { [code]: { status: 'rejected' } },
      previousPayments: [previous],
      cutoverUnix: 50,
      pulledUtc: '2026-08-21T16:00:00.000Z',
    }),
    /invalid moderation transition/,
  );
});

test('buildModerationInbox keeps raw strings local and omits decided filings', () => {
  const pending = paidSession({ id: 'cs_pending', name: 'Needs review', url: 'pending.example' });
  const approved = paidSession({ id: 'cs_approved', name: 'Done', url: 'done.example' });
  const moderation = {
    [filingCode('cs_approved')]: {
      status: 'approved', name: 'Done', url: 'https://done.example',
    },
  };
  const inbox = buildModerationInbox([pending, approved], moderation, 50);

  assert.deepEqual(inbox, [{
    filing_code: filingCode('cs_pending'),
    amount_pence: 1337,
    paid_utc: '1970-01-01T00:01:40.000Z',
    name_raw: 'Needs review',
    url_raw: 'pending.example',
  }]);
});

test('buildModerationInbox keeps invalid approvals available for correction', () => {
  const session = paidSession({ id: 'cs_invalid', name: 'Needs fix', url: 'raw.example' });
  const code = filingCode(session.id);
  const moderation = {
    [code]: { status: 'approved', name: 'Bad URL', url: 'javascript:alert(1)' },
  };

  const inbox = buildModerationInbox([session], moderation, 50);

  assert.equal(inbox.length, 1);
  assert.equal(inbox[0].filing_code, code);
  assert.equal(inbox[0].name_raw, 'Needs fix');
});

test('Stripe polling stops after the configured timeout', async () => {
  const { stripeGet } = await import('./poll.mjs');
  assert.equal(typeof stripeGet, 'function');
  const fetchImpl = async (_url, options) => new Promise((_resolve, reject) => {
    options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true });
  });

  await assert.rejects(
    stripeGet({
      fetchImpl,
      key: 'rk_test',
      path: 'checkout/sessions?limit=1',
      timeoutMs: 5,
    }),
    /Stripe GET timed out/,
  );
});

test('withPollLock prevents a stale poll from following owner removal', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'bribeboard-poll-lock-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const { withPollLock } = await import('./poll.mjs');
  assert.equal(typeof withPollLock, 'function');

  let releaseRemoval;
  let removalStarted;
  const gate = new Promise((resolve) => { releaseRemoval = resolve; });
  const started = new Promise((resolve) => { removalStarted = resolve; });
  const writes = [];

  const removal = withPollLock(directory, async () => {
    removalStarted();
    await gate;
    writes.push('removed');
  });
  await started;

  await assert.rejects(
    withPollLock(directory, async () => writes.push('approved')),
    /poll is already locked/,
  );
  releaseRemoval();
  await removal;
  assert.deepEqual(writes, ['removed']);
});

function validAttestation() {
  return {
    verified: true,
    cutover_utc: '2026-08-21T17:00:00.000Z',
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

function paidSession({
  id = 'cs_test',
  created = 100,
  amount = 1337,
  refunded = 0,
  disputedAmount = 0,
  disputeStatus = disputedAmount > 0 ? 'needs_response' : null,
  currency = 'gbp',
  disputeBalanceTransactions = disputedAmount > 0
    ? [{ amount: -disputedAmount, currency }]
    : [],
  status = 'complete',
  paymentStatus = 'paid',
  name = 'Raw Project',
  url = 'raw.example',
} = {}) {
  return {
    id,
    created,
    amount_total: amount,
    status,
    payment_status: paymentStatus,
    currency,
    custom_fields: [
      { key: 'project_name', text: { value: name } },
      { key: 'project_url', text: { value: url } },
    ],
    payment_intent: {
      latest_charge: {
        amount_refunded: refunded,
        disputed: disputedAmount > 0,
        dispute: disputedAmount > 0 ? {
          amount: disputedAmount,
          status: disputeStatus,
          balance_transactions: disputeBalanceTransactions,
        } : null,
      },
    },
  };
}
