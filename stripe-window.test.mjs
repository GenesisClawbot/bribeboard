import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  migrateVibeTax,
  setPaymentLinkActive,
  validateCutoverAttestation,
  withCutoverLock,
  writeCutoverReceipt,
} from './stripe-window.mjs';

test('writeCutoverReceipt atomically replaces the durable receipt', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'bribeboard-cutover-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, 'stripe-cutover.json');

  writeCutoverReceipt(path, { verified: false, cutover_utc: 'first' });
  writeCutoverReceipt(path, { verified: true, cutover_utc: 'first' });

  assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')), {
    verified: true,
    cutover_utc: 'first',
  });
  assert.deepEqual(readdirSync(directory), ['stripe-cutover.json']);
});

test('withCutoverLock initializes a stable advisory lock marker', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'bribeboard-advisory-lock-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const receiptPath = join(directory, 'stripe-cutover.json');

  await withCutoverLock(receiptPath, async () => {
    assert.equal(
      readFileSync(`${receiptPath}.lock`, 'utf8'),
      'BRIBEBOARD_LOCK_V2\n',
    );
  });
  assert.equal(existsSync(`${receiptPath}.lock`), true);
});

test('withCutoverLock rejects a parallel cutover and releases afterward', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'bribeboard-cutover-lock-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const receiptPath = join(directory, 'stripe-cutover.json');
  let release;
  let entered;
  const gate = new Promise((resolve) => { release = resolve; });
  const started = new Promise((resolve) => { entered = resolve; });

  const first = withCutoverLock(receiptPath, async () => {
    entered();
    await gate;
    return 'first';
  });
  await started;

  await assert.rejects(
    withCutoverLock(receiptPath, async () => 'second'),
    /cutover is already locked/,
  );
  release();
  assert.equal(await first, 'first');
  assert.equal(existsSync(`${receiptPath}.lock`), true);
  assert.equal(await withCutoverLock(receiptPath, async () => 'third'), 'third');
});

test('withCutoverLock refuses a legacy PID lock', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'bribeboard-stale-lock-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const receiptPath = join(directory, 'stripe-cutover.json');
  writeFileSync(`${receiptPath}.lock`, '2147483647\n');

  await assert.rejects(
    withCutoverLock(receiptPath, async () => 'unsafe'),
    /legacy cutover lock requires manual recovery/,
  );
});

test('withCutoverLock refuses an incomplete legacy lock', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'bribeboard-incomplete-lock-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const receiptPath = join(directory, 'stripe-cutover.json');
  writeFileSync(`${receiptPath}.lock`, '');

  await assert.rejects(
    withCutoverLock(receiptPath, async () => 'unsafe'),
    /legacy cutover lock requires manual recovery/,
  );
});

test('withCutoverLock ignores obsolete contender records after PID reuse', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'bribeboard-reused-pid-lock-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const receiptPath = join(directory, 'stripe-cutover.json');
  writeFileSync(
    `${receiptPath}.lock.owner.1.${process.ppid}.old-process-token.1`,
    '',
  );

  assert.equal(await withCutoverLock(receiptPath, async () => 'recovered'), 'recovered');
});

test('Stripe requests stop after the configured timeout', async () => {
  const { stripeRequest } = await import('./stripe-window.mjs');
  assert.equal(typeof stripeRequest, 'function');
  const fetchImpl = async (_url, options) => new Promise((_resolve, reject) => {
    options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true });
  });

  await assert.rejects(
    stripeRequest({
      fetchImpl,
      key: 'rk_test',
      url: 'https://api.stripe.com/v1/payment_links/plink_test',
      timeoutMs: 5,
    }),
    /Stripe GET timed out/,
  );
});

test('setPaymentLinkActive writes the requested state and reads it back', async () => {
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url, options });
    const active = options.method === 'POST' ? false : false;
    return {
      ok: true,
      async json() {
        return { id: 'plink_test', active, url: 'https://buy.stripe.com/test' };
      },
    };
  };

  const result = await setPaymentLinkActive({
    fetchImpl,
    key: 'rk_test',
    paymentLinkId: 'plink_test',
    active: false,
  });

  assert.deepEqual(result, {
    id: 'plink_test', active: false, url: 'https://buy.stripe.com/test',
  });
  assert.equal(calls.length, 2);
  assert.equal(calls[0].options.method, 'POST');
  assert.equal(calls[0].options.body, 'active=false');
  assert.equal(calls[1].options.method, undefined);
});

test('setPaymentLinkActive fails when readback does not match', async () => {
  let call = 0;
  const fetchImpl = async () => ({
    ok: true,
    async json() {
      call += 1;
      return { id: 'plink_test', active: call === 1 ? false : true };
    },
  });

  await assert.rejects(
    setPaymentLinkActive({
      fetchImpl,
      key: 'rk_test',
      paymentLinkId: 'plink_test',
      active: false,
    }),
    /readback mismatch/,
  );
});

test('validateCutoverAttestation binds the public gate to the verified Stripe contract', () => {
  const config = {
    payment_link_id: 'plink_test',
    payment_link_url: 'https://buy.stripe.com/test',
    product_id: 'prod_test',
    price_id: 'price_test',
    currency: 'gbp',
    minimum_pence: 100,
    maximum_pence: 500000,
  };
  const receipt = validAttestation();

  assert.deepEqual(validateCutoverAttestation(receipt, config), {
    cutover_utc: '2026-08-21T17:00:00.000Z',
    payment_link_id: 'plink_test',
    payment_link_url: 'https://buy.stripe.com/test',
  });
  assert.throws(
    () => validateCutoverAttestation({
      ...receipt,
      payment_link: { ...receipt.payment_link, url: 'https://buy.stripe.com/unverified' },
    }, config),
    /cutover attestation mismatch/,
  );
});

test('migrateVibeTax closes, verifies copy, and reopens in exact order', async () => {
  const state = {
    link: {
      id: 'plink_test', active: true, currency: 'gbp',
      url: 'https://buy.stripe.com/test',
      custom_fields: validCustomFields(),
      after_completion: {
        type: 'hosted_confirmation',
        hosted_confirmation: { custom_message: 'Old promise' },
      },
    },
    product: { id: 'prod_test', name: 'Old name', description: 'Old promise' },
    price: {
      id: 'price_test', product: 'prod_test', currency: 'gbp', active: true,
      type: 'one_time', recurring: null,
      custom_unit_amount: { minimum: 100, maximum: 500000, preset: null },
    },
    lineItems: {
      data: [{ quantity: 1, price: { id: 'price_test', product: 'prod_test' } }],
      has_more: false,
    },
  };
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url, options });
    assert.equal(options.headers['Stripe-Version'], '2026-07-29.dahlia');
    const body = new URLSearchParams(options.body || '');
    const target = url.includes('/line_items')
      ? state.lineItems
      : url.includes('/products/')
        ? state.product
        : url.includes('/prices/') ? state.price : state.link;
    if (options.method === 'POST' && target === state.link && body.has('active')) {
      state.link.active = body.get('active') === 'true';
    }
    if (options.method === 'POST' && target === state.product) {
      state.product.name = body.get('name');
      state.product.description = body.get('description');
    }
    if (options.method === 'POST' && target === state.link
      && body.has('after_completion[hosted_confirmation][custom_message]')) {
      state.link.after_completion.hosted_confirmation.custom_message =
        body.get('after_completion[hosted_confirmation][custom_message]');
    }
    return response(structuredClone(target));
  };

  const receipt = await migrateVibeTax({
    fetchImpl,
    key: 'rk_test',
    stripe: {
      payment_link_id: 'plink_test', product_id: 'prod_test', price_id: 'price_test',
    },
    nowUtc: () => {
      assert.equal(calls.length, 10, 'cutover is captured after final close readback');
      return '2026-08-21T16:59:59.001Z';
    },
    persistReceipt: async () => {},
  });

  assert.equal(receipt.verified, true);
  assert.equal(receipt.cutover_utc, '2026-08-21T17:00:00.000Z');
  assert.equal(receipt.payment_link.active, true);
  assert.equal(receipt.payment_link.url, 'https://buy.stripe.com/test');
  assert.match(receipt.product.description, /Does not buy rank, traffic/);
  assert.deepEqual(calls.map(callShape), [
    ['POST', '/v1/payment_links/plink_test', 'active=false'],
    ['GET', '/v1/payment_links/plink_test', ''],
    ['POST', '/v1/products/prod_test', 'name=Bribeboard+Vibe+Tax+Filing&description=One+moderated+public+comic+tax+filing+for+a+nominated+side+project.+Does+not+buy+rank%2C+traffic%2C+owner+verification%2C+endorsement%2C+or+a+review.'],
    ['GET', '/v1/products/prod_test', ''],
    ['POST', '/v1/payment_links/plink_test', 'after_completion%5Btype%5D=hosted_confirmation&after_completion%5Bhosted_confirmation%5D%5Bcustom_message%5D=Payment+received.+Your+filing+is+pending+manual+moderation.+Publication+normally+takes+about+one+hour+during+08%3A30+to+23%3A30+London.+Save+this+page+for+your+receipt.'],
    ['GET', '/v1/payment_links/plink_test', ''],
    ['GET', '/v1/prices/price_test', ''],
    ['GET', '/v1/payment_links/plink_test/line_items', ''],
    ['POST', '/v1/payment_links/plink_test', 'active=false'],
    ['GET', '/v1/payment_links/plink_test', ''],
    ['GET', '/v1/payment_links/plink_test', ''],
    ['POST', '/v1/payment_links/plink_test', 'active=true'],
    ['GET', '/v1/payment_links/plink_test', ''],
    ['GET', '/v1/payment_links/plink_test', ''],
    ['GET', '/v1/products/prod_test', ''],
    ['GET', '/v1/prices/price_test', ''],
    ['GET', '/v1/payment_links/plink_test/line_items', ''],
  ]);
});

test('migrateVibeTax stops while the link is closed on copy mismatch', async () => {
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url, options });
    if (url.includes('/products/')) {
      return response({ id: 'prod_test', name: 'Wrong', description: 'Wrong' });
    }
    return response({
      id: 'plink_test', active: false,
      after_completion: {
        type: 'hosted_confirmation',
        hosted_confirmation: { custom_message: 'Old promise' },
      },
    });
  };

  await assert.rejects(
    migrateVibeTax({
      fetchImpl,
      key: 'rk_test',
      stripe: { payment_link_id: 'plink_test', product_id: 'prod_test' },
      nowUtc: () => '2026-08-21T17:00:00.000Z',
      persistReceipt: async () => {},
    }),
    /product readback mismatch/,
  );

  assert.equal(calls.some(({ options }) => options.body === 'active=true'), false);
  assert.equal(calls.length, 4);
});

test('migrateVibeTax refuses a bad amount rail before reopening', async () => {
  const state = migrationState();
  state.price.custom_unit_amount.maximum = 499999;
  const calls = [];
  const fetchImpl = migrationFetch(state, calls);

  await assert.rejects(
    migrateVibeTax({
      fetchImpl,
      key: 'rk_test',
      stripe: {
        payment_link_id: 'plink_test', product_id: 'prod_test', price_id: 'price_test',
      },
      nowUtc: () => '2026-08-21T17:00:00.001Z',
      persistReceipt: async () => {},
    }),
    /payment rail readback mismatch/,
  );

  assert.equal(state.link.active, false);
  assert.equal(calls.some(({ options }) => options.body === 'active=true'), false);
});

test('migrateVibeTax refuses an inactive price before reopening', async () => {
  const state = migrationState();
  state.price.active = false;
  const calls = [];

  await assert.rejects(
    migrateVibeTax({
      fetchImpl: migrationFetch(state, calls),
      key: 'rk_test',
      stripe: {
        payment_link_id: 'plink_test', product_id: 'prod_test', price_id: 'price_test',
      },
      nowUtc: () => '2026-08-21T17:00:00.001Z',
      persistReceipt: async () => {},
    }),
    /payment rail readback mismatch/,
  );

  assert.equal(state.link.active, false);
  assert.equal(calls.some(({ options }) => options.body === 'active=true'), false);
});

test('migrateVibeTax refuses a recurring price before reopening', async () => {
  const state = migrationState();
  state.price.type = 'recurring';
  state.price.recurring = { interval: 'month' };
  const calls = [];

  await assert.rejects(
    migrateVibeTax({
      fetchImpl: migrationFetch(state, calls),
      key: 'rk_test',
      stripe: {
        payment_link_id: 'plink_test', product_id: 'prod_test', price_id: 'price_test',
      },
      nowUtc: () => '2026-08-21T17:00:00.001Z',
      persistReceipt: async () => {},
    }),
    /payment rail readback mismatch/,
  );

  assert.equal(state.link.active, false);
  assert.equal(calls.some(({ options }) => options.body === 'active=true'), false);
});

test('migrateVibeTax accepts the retrieved custom amount Price shape', async () => {
  const state = migrationState();
  const calls = [];

  const receipt = await migrateVibeTax({
    fetchImpl: migrationFetch(state, calls),
    key: 'rk_test',
    stripe: {
      payment_link_id: 'plink_test', product_id: 'prod_test', price_id: 'price_test',
    },
    nowUtc: () => '2026-08-21T17:00:00.001Z',
    waitUntilUtc: async () => {},
    persistReceipt: async () => {},
  });

  assert.equal(receipt.verified, true);
  assert.equal(receipt.payment_link.minimum_pence, 100);
  assert.equal(receipt.payment_link.maximum_pence, 500000);
});

test('migrateVibeTax verifies the link uses the configured price and product', async () => {
  const state = migrationState();
  state.lineItems.data[0].price.id = 'price_other';
  const calls = [];

  await assert.rejects(
    migrateVibeTax({
      fetchImpl: migrationFetch(state, calls),
      key: 'rk_test',
      stripe: {
        payment_link_id: 'plink_test', product_id: 'prod_test', price_id: 'price_test',
      },
      nowUtc: () => '2026-08-21T17:00:00.001Z',
      persistReceipt: async () => {},
    }),
    /line item readback mismatch/,
  );

  assert.equal(state.link.active, false);
  assert.equal(calls.some(({ options }) => options.body === 'active=true'), false);
});

test('migrateVibeTax requires hosted confirmation before reopening', async () => {
  const state = migrationState();
  state.link.after_completion.type = 'redirect';
  const calls = [];

  await assert.rejects(
    migrateVibeTax({
      fetchImpl: migrationFetch(state, calls),
      key: 'rk_test',
      stripe: {
        payment_link_id: 'plink_test', product_id: 'prod_test', price_id: 'price_test',
      },
      nowUtc: () => '2026-08-21T17:00:00.001Z',
      persistReceipt: async () => {},
    }),
    /completion copy readback mismatch/,
  );

  assert.equal(state.link.active, false);
});

test('migrateVibeTax requires exact text field settings before reopening', async () => {
  const cases = [
    ['optional URL', (state) => { state.link.custom_fields[0].optional = true; }],
    ['wrong name type', (state) => { state.link.custom_fields[1].type = 'dropdown'; }],
    ['wrong URL limit', (state) => {
      state.link.custom_fields[0].text.maximum_length = 199;
    }],
    ['URL minimum added', (state) => {
      state.link.custom_fields[0].text.minimum_length = 200;
    }],
    ['name default added', (state) => {
      state.link.custom_fields[1].text.default_value = 'Injected name';
    }],
    ['wrong name label', (state) => {
      state.link.custom_fields[1].label.custom = 'Your full name';
    }],
  ];

  for (const [label, mutate] of cases) {
    const state = migrationState();
    mutate(state);
    const calls = [];
    await assert.rejects(
      migrateVibeTax({
        fetchImpl: migrationFetch(state, calls),
        key: 'rk_test',
        stripe: {
          payment_link_id: 'plink_test', product_id: 'prod_test', price_id: 'price_test',
        },
        nowUtc: () => '2026-08-21T17:00:00.001Z',
        persistReceipt: async () => {},
      }),
      /custom field readback mismatch/,
      label,
    );
    assert.equal(state.link.active, false, label);
  }
});

test('migrateVibeTax closes a concurrent reactivation before persisting', async () => {
  const state = migrationState();
  const calls = [];
  const baseFetch = migrationFetch(state, calls);
  let confirmationWritten = false;
  let reactivated = false;
  const fetchImpl = async (url, options = {}) => {
    const body = new URLSearchParams(options.body || '');
    if (options.method === 'POST'
      && body.has('after_completion[hosted_confirmation][custom_message]')) {
      confirmationWritten = true;
    } else if (!options.method && confirmationWritten && !reactivated
      && url.endsWith('/payment_links/plink_test')) {
      state.link.active = true;
      reactivated = true;
    }
    return baseFetch(url, options);
  };

  const receipt = await migrateVibeTax({
    fetchImpl,
    key: 'rk_test',
    stripe: {
      payment_link_id: 'plink_test', product_id: 'prod_test', price_id: 'price_test',
    },
    nowUtc: () => '2026-08-21T17:00:00.001Z',
    persistReceipt: async (value) => {
      if (!value.verified) assert.equal(state.link.active, false);
    },
  });

  assert.equal(reactivated, true);
  assert.equal(receipt.verified, true);
  assert.equal(state.link.active, true);
});

test('migrateVibeTax stops on unexpected activation before its boundary', async () => {
  const state = migrationState();
  const receipts = [];

  await assert.rejects(
    migrateVibeTax({
      fetchImpl: migrationFetch(state, []),
      key: 'rk_test',
      stripe: {
        payment_link_id: 'plink_test', product_id: 'prod_test', price_id: 'price_test',
      },
      nowUtc: () => '2026-08-21T17:00:00.001Z',
      waitUntilUtc: async () => { state.link.active = true; },
      persistReceipt: async (value) => { receipts.push(structuredClone(value)); },
    }),
    /unexpected Payment Link activation before cutover/,
  );

  assert.equal(state.link.active, false);
  assert.equal(receipts.at(-1).verified, false);
  assert.equal(receipts.at(-1).unexpected_activation, true);
});

test('migrateVibeTax closes unexpected activation when taint persistence fails', async () => {
  const state = migrationState();

  await assert.rejects(
    migrateVibeTax({
      fetchImpl: migrationFetch(state, []),
      key: 'rk_test',
      stripe: {
        payment_link_id: 'plink_test', product_id: 'prod_test', price_id: 'price_test',
      },
      nowUtc: () => '2026-08-21T17:00:00.001Z',
      waitUntilUtc: async () => { state.link.active = true; },
      persistReceipt: async (value) => {
        if (value.unexpected_activation) throw new Error('disk unavailable');
      },
    }),
    /disk unavailable/,
  );

  assert.equal(state.link.active, false);
});

test('migrateVibeTax requires an audit after uncertain taint persistence', async () => {
  const state = migrationState();
  let durableReceipt;
  const stripe = {
    payment_link_id: 'plink_test', product_id: 'prod_test', price_id: 'price_test',
  };

  await assert.rejects(
    migrateVibeTax({
      fetchImpl: migrationFetch(state, []),
      key: 'rk_test',
      stripe,
      nowUtc: () => '2026-08-21T17:00:00.001Z',
      waitUntilUtc: async () => { state.link.active = true; },
      persistReceipt: async (value) => {
        if (value.unexpected_activation) throw new Error('disk unavailable');
        durableReceipt = structuredClone(value);
      },
    }),
    /disk unavailable/,
  );

  assert.equal(state.link.active, false);
  await assert.rejects(
    migrateVibeTax({
      fetchImpl: migrationFetch(state, []),
      key: 'rk_test',
      stripe,
      nowUtc: () => '2026-08-21T17:00:02.001Z',
      persistReceipt: async () => {},
      existingReceipt: durableReceipt,
    }),
    /incomplete cutover requires a manual Session audit/,
  );
  assert.equal(state.link.active, false);
});

test('migrateVibeTax derives the boundary from Stripe time', async () => {
  const state = migrationState();
  const baseFetch = migrationFetch(state, []);
  const fetchImpl = async (url, options = {}) => {
    const result = await baseFetch(url, options);
    return {
      ...result,
      headers: {
        get(name) {
          return name.toLowerCase() === 'date'
            ? 'Fri, 21 Aug 2026 17:00:00 GMT'
            : null;
        },
      },
    };
  };

  const receipt = await migrateVibeTax({
    fetchImpl,
    key: 'rk_test',
    stripe: {
      payment_link_id: 'plink_test', product_id: 'prod_test', price_id: 'price_test',
    },
    nowUtc: () => '2030-01-01T00:00:00.000Z',
    waitUntilUtc: async () => {},
    persistReceipt: async () => {},
  });

  assert.equal(receipt.cutover_utc, '2026-08-21T17:00:01.000Z');
});

test('migrateVibeTax waits past the next Stripe second before reopening', async () => {
  const state = migrationState();
  const baseFetch = migrationFetch(state, []);
  const fetchImpl = async (url, options = {}) => {
    const result = await baseFetch(url, options);
    return {
      ...result,
      headers: {
        get(name) {
          return name.toLowerCase() === 'date'
            ? 'Fri, 21 Aug 2026 17:00:00 GMT'
            : null;
        },
      },
    };
  };
  const started = Date.now();

  await migrateVibeTax({
    fetchImpl,
    key: 'rk_test',
    stripe: {
      payment_link_id: 'plink_test', product_id: 'prod_test', price_id: 'price_test',
    },
    nowUtc: () => '2030-01-01T00:00:00.000Z',
    persistReceipt: async () => {},
  });

  assert.ok(Date.now() - started >= 900);
});

test('migrateVibeTax persists the cutover boundary before reopening', async () => {
  const state = migrationState();
  const calls = [];
  const receipts = [];

  const receipt = await migrateVibeTax({
    fetchImpl: migrationFetch(state, calls),
    key: 'rk_test',
    stripe: {
      payment_link_id: 'plink_test', product_id: 'prod_test', price_id: 'price_test',
    },
    nowUtc: () => '2026-08-21T17:00:00.001Z',
    persistReceipt: async (value) => {
      receipts.push(structuredClone(value));
      if (!value.verified) assert.equal(state.link.active, false);
    },
  });

  assert.equal(receipts.length, 3);
  assert.equal(receipts[0].verified, false);
  assert.equal(receipts[0].activation_started, false);
  assert.equal(receipts[0].cutover_utc, '2026-08-21T17:00:01.000Z');
  assert.equal(receipts[1].verified, false);
  assert.equal(receipts[1].activation_started, true);
  assert.equal(receipts[2].verified, true);
  assert.deepEqual(receipts[2], receipt);
});

test('migrateVibeTax waits for the stored cutover boundary before reopening', async () => {
  const state = migrationState();
  const waits = [];

  await migrateVibeTax({
    fetchImpl: migrationFetch(state, []),
    key: 'rk_test',
    stripe: {
      payment_link_id: 'plink_test', product_id: 'prod_test', price_id: 'price_test',
    },
    nowUtc: () => '2026-08-21T17:00:00.001Z',
    waitUntilUtc: async (cutoverUtc) => {
      assert.equal(state.link.active, false);
      waits.push(cutoverUtc);
    },
    persistReceipt: async () => {},
  });

  assert.deepEqual(waits, ['2026-08-21T17:00:01.000Z']);
});

test('migrateVibeTax leaves the link closed when cutover persistence fails', async () => {
  const state = migrationState();
  const calls = [];

  await assert.rejects(
    migrateVibeTax({
      fetchImpl: migrationFetch(state, calls),
      key: 'rk_test',
      stripe: {
        payment_link_id: 'plink_test', product_id: 'prod_test', price_id: 'price_test',
      },
      nowUtc: () => '2026-08-21T17:00:00.001Z',
      persistReceipt: async () => { throw new Error('disk unavailable'); },
    }),
    /disk unavailable/,
  );

  assert.equal(state.link.active, false);
  assert.equal(calls.some(({ options }) => options.body === 'active=true'), false);
});

test('migrateVibeTax requires an audit for an incomplete cutover', async () => {
  const state = migrationState();
  const existingReceipt = {
    verified: false,
    cutover_utc: '2026-08-21T17:00:01.000Z',
    payment_link_id: 'plink_test',
    product_id: 'prod_test',
    price_id: 'price_test',
  };

  await assert.rejects(
    migrateVibeTax({
      fetchImpl: migrationFetch(state, []),
      key: 'rk_test',
      stripe: {
        payment_link_id: 'plink_test', product_id: 'prod_test', price_id: 'price_test',
      },
      nowUtc: () => '2026-08-21T17:00:02.001Z',
      persistReceipt: async () => {},
      existingReceipt,
    }),
    /incomplete cutover requires a manual Session audit/,
  );

  assert.equal(state.link.active, false);
});

test('migrateVibeTax revalidates a verified contract without rewriting it', async () => {
  const state = migrationState();
  const attestation = validAttestation();
  state.product = structuredClone(attestation.product);
  state.link.after_completion.hosted_confirmation.custom_message =
    attestation.payment_link.completion_message;
  const calls = [];
  const receipts = [];

  const receipt = await migrateVibeTax({
    fetchImpl: migrationFetch(state, calls),
    key: 'rk_test',
    stripe: {
      payment_link_id: 'plink_test', product_id: 'prod_test', price_id: 'price_test',
    },
    persistReceipt: async (value) => { receipts.push(value); },
    existingReceipt: attestation,
  });

  assert.equal(receipt.cutover_utc, attestation.cutover_utc);
  assert.equal(receipts.at(-1).verified, true);
  assert.equal(calls.some(({ options }) => options.method === 'POST'), false);
});

test('migrateVibeTax closes and refuses to repair drift under a verified boundary', async () => {
  const state = migrationState();
  const calls = [];
  const receipts = [];

  await assert.rejects(
    migrateVibeTax({
      fetchImpl: migrationFetch(state, calls),
      key: 'rk_test',
      stripe: {
        payment_link_id: 'plink_test', product_id: 'prod_test', price_id: 'price_test',
      },
      nowUtc: () => '2026-08-21T17:00:00.001Z',
      persistReceipt: async (value) => { receipts.push(value); },
      existingReceipt: validAttestation(),
    }),
    /verified Checkout contract drift/,
  );

  assert.equal(state.link.active, false);
  assert.equal(receipts.at(-1).verified, false);
  assert.equal(calls.some(({ url, options }) =>
    options.method === 'POST' && url.includes('/products/')), false);
});

test('migrateVibeTax closes verified drift when receipt invalidation fails', async () => {
  const state = migrationState();

  await assert.rejects(
    migrateVibeTax({
      fetchImpl: migrationFetch(state, []),
      key: 'rk_test',
      stripe: {
        payment_link_id: 'plink_test', product_id: 'prod_test', price_id: 'price_test',
      },
      persistReceipt: async (value) => {
        if (!value.verified) throw new Error('receipt disk unavailable');
      },
      existingReceipt: validAttestation(),
    }),
    /receipt disk unavailable/,
  );

  assert.equal(state.link.active, false);
});

test('migrateVibeTax closes the link when verified receipt durability is uncertain', async () => {
  const state = migrationState();
  const receipts = [];
  let failed = false;

  await assert.rejects(
    migrateVibeTax({
      fetchImpl: migrationFetch(state, []),
      key: 'rk_test',
      stripe: {
        payment_link_id: 'plink_test', product_id: 'prod_test', price_id: 'price_test',
      },
      nowUtc: () => '2026-08-21T17:00:00.001Z',
      persistReceipt: async (value) => {
        receipts.push(structuredClone(value));
        if (value.verified && !failed) {
          failed = true;
          throw new Error('post-rename directory fsync failed');
        }
      },
    }),
    /post-rename directory fsync failed/,
  );

  assert.equal(state.link.active, false);
  assert.equal(receipts.at(-1).verified, false);
  assert.equal(receipts.at(-1).activation_started, true);
  assert.equal(receipts.at(-1).payment_link.active, false);
});

test('migrateVibeTax preserves the boundary after activation may have started', async () => {
  const state = migrationState();
  let durableReceipt;
  let failVerifiedWrite = true;
  const persistReceipt = async (value) => {
    if (value.verified && failVerifiedWrite) {
      throw new Error('verified receipt did not reach rename');
    }
    durableReceipt = structuredClone(value);
  };

  await assert.rejects(
    migrateVibeTax({
      fetchImpl: migrationFetch(state, []),
      key: 'rk_test',
      stripe: {
        payment_link_id: 'plink_test', product_id: 'prod_test', price_id: 'price_test',
      },
      nowUtc: () => '2026-08-21T17:00:00.001Z',
      persistReceipt,
    }),
    /verified receipt did not reach rename/,
  );

  assert.equal(state.link.active, false);
  assert.equal(durableReceipt.verified, false);
  assert.equal(durableReceipt.activation_started, true);
  const boundary = durableReceipt.cutover_utc;

  failVerifiedWrite = false;
  const receipt = await migrateVibeTax({
    fetchImpl: migrationFetch(state, []),
    key: 'rk_test',
    stripe: {
      payment_link_id: 'plink_test', product_id: 'prod_test', price_id: 'price_test',
    },
    nowUtc: () => { throw new Error('must preserve activation boundary'); },
    persistReceipt,
    existingReceipt: durableReceipt,
  });

  assert.equal(receipt.verified, true);
  assert.equal(receipt.cutover_utc, boundary);
});

test('migrateVibeTax resumes a closed activation with the same boundary', async () => {
  const state = migrationState();
  const activationReceipt = {
    ...validAttestation(),
    verified: false,
    activation_started: true,
    payment_link: { ...validAttestation().payment_link, active: false },
  };
  state.link.active = false;
  state.product = structuredClone(activationReceipt.product);
  state.link.after_completion.hosted_confirmation.custom_message =
    activationReceipt.payment_link.completion_message;

  const receipt = await migrateVibeTax({
    fetchImpl: migrationFetch(state, []),
    key: 'rk_test',
    stripe: {
      payment_link_id: 'plink_test', product_id: 'prod_test', price_id: 'price_test',
    },
    nowUtc: () => { throw new Error('must preserve activation boundary'); },
    persistReceipt: async () => {},
    existingReceipt: activationReceipt,
  });

  assert.equal(state.link.active, true);
  assert.equal(receipt.cutover_utc, activationReceipt.cutover_utc);
  assert.equal(receipt.verified, true);
});

test('migrateVibeTax rejects Checkout contract drift on final reopen readback', async () => {
  const state = migrationState();
  const calls = [];
  const baseFetch = migrationFetch(state, calls);
  const fetchImpl = async (url, options = {}) => {
    const result = await baseFetch(url, options);
    const body = new URLSearchParams(options.body || '');
    if (options.method === 'POST' && body.get('active') === 'true') {
      state.product.name = 'Buy rank on Bribeboard';
      state.product.description = 'Pay more to rank higher.';
      state.link.after_completion.hosted_confirmation.custom_message =
        'Payment received. Your rank is live.';
      state.link.custom_fields = [validCustomFields()[0]];
    }
    return result;
  };

  await assert.rejects(
    migrateVibeTax({
      fetchImpl,
      key: 'rk_test',
      stripe: {
        payment_link_id: 'plink_test', product_id: 'prod_test', price_id: 'price_test',
      },
      nowUtc: () => '2026-08-21T17:00:00.001Z',
      waitUntilUtc: async () => {},
      persistReceipt: async () => {},
    }),
    /readback mismatch/,
  );

  assert.equal(state.link.active, false);
});

test('migrateVibeTax compensates with a verified close after reopen mismatch', async () => {
  const state = migrationState();
  const calls = [];
  let spoilReopenReadback = true;
  const baseFetch = migrationFetch(state, calls);
  const fetchImpl = async (url, options = {}) => {
    const result = await baseFetch(url, options);
    if (!options.method && url.includes('/payment_links/')
      && state.link.active && spoilReopenReadback) {
      spoilReopenReadback = false;
      return response({ ...state.link, active: false });
    }
    return result;
  };

  await assert.rejects(
    migrateVibeTax({
      fetchImpl,
      key: 'rk_test',
      stripe: {
        payment_link_id: 'plink_test', product_id: 'prod_test', price_id: 'price_test',
      },
      nowUtc: () => '2026-08-21T17:00:00.001Z',
      persistReceipt: async () => {},
    }),
    /readback mismatch/,
  );

  assert.equal(state.link.active, false);
  assert.deepEqual(calls.slice(-2).map(callShape), [
    ['POST', '/v1/payment_links/plink_test', 'active=false'],
    ['GET', '/v1/payment_links/plink_test', ''],
  ]);
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

function validCustomFields() {
  return [
    {
      key: 'project_url', optional: false, type: 'text',
      label: { type: 'custom', custom: 'Project URL' },
      text: { default_value: null, maximum_length: 200, minimum_length: null },
    },
    {
      key: 'project_name', optional: false, type: 'text',
      label: { type: 'custom', custom: 'Project name' },
      text: { default_value: null, maximum_length: 60, minimum_length: null },
    },
  ];
}

function migrationState() {
  return {
    link: {
      id: 'plink_test', active: true, currency: 'gbp',
      url: 'https://buy.stripe.com/test',
      custom_fields: validCustomFields(),
      after_completion: {
        type: 'hosted_confirmation',
        hosted_confirmation: { custom_message: 'Old promise' },
      },
    },
    product: { id: 'prod_test', name: 'Old name', description: 'Old promise' },
    price: {
      id: 'price_test', product: 'prod_test', currency: 'gbp', active: true,
      type: 'one_time', recurring: null,
      custom_unit_amount: { minimum: 100, maximum: 500000, preset: null },
    },
    lineItems: {
      data: [{ quantity: 1, price: { id: 'price_test', product: 'prod_test' } }],
      has_more: false,
    },
  };
}

function migrationFetch(state, calls) {
  return async (url, options = {}) => {
    calls.push({ url, options });
    const body = new URLSearchParams(options.body || '');
    const target = url.includes('/line_items')
      ? state.lineItems
      : url.includes('/products/')
        ? state.product
        : url.includes('/prices/') ? state.price : state.link;
    if (options.method === 'POST' && target === state.link && body.has('active')) {
      state.link.active = body.get('active') === 'true';
    }
    if (options.method === 'POST' && target === state.product) {
      state.product.name = body.get('name');
      state.product.description = body.get('description');
    }
    if (options.method === 'POST' && target === state.link
      && body.has('after_completion[hosted_confirmation][custom_message]')) {
      state.link.after_completion.hosted_confirmation.custom_message =
        body.get('after_completion[hosted_confirmation][custom_message]');
    }
    return response(structuredClone(target));
  };
}

function response(value) {
  return { ok: true, async json() { return value; } };
}

function callShape({ url, options }) {
  return [
    options.method || 'GET',
    new URL(url).pathname,
    options.body || '',
  ];
}
