#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  closeSync,
  fsyncSync,
  linkSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const STRIPE_API_VERSION = '2026-07-29.dahlia';
const PRODUCT_NAME = 'Bribeboard Vibe Tax Filing';
const PRODUCT_DESCRIPTION = 'One moderated public comic tax filing for a nominated side project. Does not buy rank, traffic, owner verification, endorsement, or a review.';
const COMPLETION_MESSAGE = 'Payment received. Your filing is pending manual moderation. Publication normally takes about one hour during 08:30 to 23:30 London. Save this page for your receipt.';
const STRIPE_SERVER_UTC = Symbol('stripeServerUtc');

export async function setPaymentLinkActive({ fetchImpl, key, paymentLinkId, active }) {
  const url = `https://api.stripe.com/v1/payment_links/${paymentLinkId}`;
  await stripeRequest({
    fetchImpl, key, url, method: 'POST', form: { active: String(active) },
  });
  const readback = await stripeRequest({ fetchImpl, key, url });
  if (readback.id !== paymentLinkId || readback.active !== active) {
    throw new Error(`readback mismatch: expected ${paymentLinkId} active=${active}, got ${readback.id} active=${readback.active}`);
  }
  const result = { id: readback.id, active: readback.active, url: readback.url };
  if (readback[STRIPE_SERVER_UTC]) result.server_utc = readback[STRIPE_SERVER_UTC];
  return result;
}

export async function migrateVibeTax({
  fetchImpl,
  key,
  stripe,
  nowUtc,
  waitUntilUtc,
  persistReceipt,
  existingReceipt,
}) {
  if (typeof persistReceipt !== 'function') {
    throw new TypeError('persistReceipt must durably save each cutover receipt');
  }
  validateExistingReceipt(existingReceipt, stripe);

  const linkUrl = `https://api.stripe.com/v1/payment_links/${stripe.payment_link_id}`;
  const productUrl = `https://api.stripe.com/v1/products/${stripe.product_id}`;

  if (existingReceipt?.verified === false
    && existingReceipt.unexpected_activation === true) {
    await setPaymentLinkActive({
      fetchImpl, key, paymentLinkId: stripe.payment_link_id, active: false,
    });
    throw new Error('unexpected activation requires a manual Session audit');
  }

  if (existingReceipt?.verified === false
    && existingReceipt.activation_started !== true) {
    await setPaymentLinkActive({
      fetchImpl, key, paymentLinkId: stripe.payment_link_id, active: false,
    });
    throw new Error('incomplete cutover requires a manual Session audit');
  }

  if (existingReceipt?.verified === false
    && existingReceipt.activation_started === true) {
    let contract;
    try {
      contract = await readCheckoutContract({ fetchImpl, key, stripe, linkUrl, productUrl });
      if (contract.paymentLink.active !== true) {
        await setPaymentLinkActive({
          fetchImpl, key, paymentLinkId: stripe.payment_link_id, active: true,
        });
        contract = await readCheckoutContract({ fetchImpl, key, stripe, linkUrl, productUrl });
        if (contract.paymentLink.active !== true) {
          throw new Error('recovered Payment Link is not active');
        }
      }
    } catch (error) {
      await setPaymentLinkActive({
        fetchImpl, key, paymentLinkId: stripe.payment_link_id, active: false,
      });
      await persistReceipt({
        ...existingReceipt,
        activation_started: false,
        payment_link: { ...existingReceipt.payment_link, active: false },
      });
      throw new Error('activation recovery contract drift', { cause: error });
    }
    const receipt = {
      ...cutoverReceipt({
        verified: true,
        cutoverUtc: existingReceipt.cutover_utc,
        stripe,
        ...contract,
      }),
      activation_started: true,
    };
    await persistReceipt(receipt);
    return receipt;
  }

  if (existingReceipt?.verified === true) {
    let contract;
    try {
      contract = await readCheckoutContract({ fetchImpl, key, stripe, linkUrl, productUrl });
      if (contract.paymentLink.active !== true) {
        throw new Error('verified Payment Link is not active');
      }
    } catch (error) {
      await setPaymentLinkActive({
        fetchImpl, key, paymentLinkId: stripe.payment_link_id, active: false,
      });
      const invalidReceipt = {
        ...existingReceipt,
        verified: false,
        activation_started: false,
        payment_link: { ...existingReceipt.payment_link, active: false },
      };
      await persistReceipt(invalidReceipt);
      throw new Error('verified Checkout contract drift', { cause: error });
    }
    const receipt = cutoverReceipt({
      verified: true,
      cutoverUtc: existingReceipt.cutover_utc,
      stripe,
      ...contract,
    });
    await persistReceipt(receipt);
    return receipt;
  }

  await setPaymentLinkActive({
    fetchImpl, key, paymentLinkId: stripe.payment_link_id, active: false,
  });

  await stripeRequest({
    fetchImpl,
    key,
    url: productUrl,
    method: 'POST',
    form: { name: PRODUCT_NAME, description: PRODUCT_DESCRIPTION },
  });
  const product = await stripeRequest({ fetchImpl, key, url: productUrl });
  validateProduct(product, stripe);

  await stripeRequest({
    fetchImpl,
    key,
    url: linkUrl,
    method: 'POST',
    form: {
      'after_completion[type]': 'hosted_confirmation',
      'after_completion[hosted_confirmation][custom_message]': COMPLETION_MESSAGE,
    },
  });
  const confirmation = await stripeRequest({ fetchImpl, key, url: linkUrl });
  const fieldKeys = validatePaymentLink(confirmation);

  const price = await stripeRequest({
    fetchImpl,
    key,
    url: `https://api.stripe.com/v1/prices/${stripe.price_id}`,
  });
  validatePrice(price, stripe);

  const lineItems = await stripeRequest({
    fetchImpl,
    key,
    url: `${linkUrl}/line_items?limit=2`,
  });
  validateLineItems(lineItems, stripe);

  const closedPaymentLink = await setPaymentLinkActive({
    fetchImpl, key, paymentLinkId: stripe.payment_link_id, active: false,
  });
  const boundaryClock = closedPaymentLink.server_utc ?? nowUtc?.();
  if (!boundaryClock) {
    throw new TypeError('Stripe close readback did not provide server time');
  }
  const cutoverUtc = nextWholeSecond(boundaryClock);

  const pendingReceipt = {
    ...cutoverReceipt({
      verified: false,
      cutoverUtc,
      stripe,
      product,
      price,
      fieldKeys,
      paymentLink: { ...confirmation, ...closedPaymentLink },
    }),
    activation_started: false,
  };
  await persistReceipt(pendingReceipt);
  if (typeof waitUntilUtc === 'function') {
    await waitUntilUtc(cutoverUtc);
  } else if (closedPaymentLink.server_utc) {
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 1000));
  } else {
    await waitUntil(cutoverUtc);
  }
  const beforeActivation = await stripeRequest({ fetchImpl, key, url: linkUrl });
  if (beforeActivation.id !== stripe.payment_link_id
    || beforeActivation.active !== false) {
    const taintedReceipt = {
      ...pendingReceipt,
      activation_started: true,
      unexpected_activation: true,
    };
    let persistError;
    try {
      await persistReceipt(taintedReceipt);
    } catch (error) {
      persistError = error;
    }
    try {
      await setPaymentLinkActive({
        fetchImpl, key, paymentLinkId: stripe.payment_link_id, active: false,
      });
    } catch (closeError) {
      if (persistError) {
        throw new AggregateError(
          [persistError, closeError],
          'taint persistence failed and unexpected activation could not be closed',
        );
      }
      throw new AggregateError(
        [closeError],
        'unexpected activation could not be closed',
      );
    }
    if (persistError) throw persistError;
    throw new Error('unexpected Payment Link activation before cutover');
  }
  const activationReceipt = { ...pendingReceipt, activation_started: true };
  await persistReceipt(activationReceipt);

  let paymentLink;
  let receipt;
  try {
    await setPaymentLinkActive({
      fetchImpl, key, paymentLinkId: stripe.payment_link_id, active: true,
    });
    paymentLink = await stripeRequest({ fetchImpl, key, url: linkUrl });
    if (paymentLink.id !== stripe.payment_link_id || paymentLink.active !== true) {
      throw new Error('final Payment Link readback mismatch');
    }
    const finalFieldKeys = validatePaymentLink(paymentLink);
    const finalProduct = await stripeRequest({ fetchImpl, key, url: productUrl });
    validateProduct(finalProduct, stripe);
    const finalPrice = await stripeRequest({
      fetchImpl,
      key,
      url: `https://api.stripe.com/v1/prices/${stripe.price_id}`,
    });
    validatePrice(finalPrice, stripe);
    const finalLineItems = await stripeRequest({
      fetchImpl,
      key,
      url: `${linkUrl}/line_items?limit=2`,
    });
    validateLineItems(finalLineItems, stripe);
    receipt = {
      ...cutoverReceipt({
        verified: true,
        cutoverUtc,
        stripe,
        product: finalProduct,
        price: finalPrice,
        fieldKeys: finalFieldKeys,
        paymentLink,
      }),
      activation_started: true,
    };
  } catch (error) {
    try {
      await setPaymentLinkActive({
        fetchImpl, key, paymentLinkId: stripe.payment_link_id, active: false,
      });
    } catch (closeError) {
      throw new AggregateError(
        [error, closeError],
        'reopen failed and compensating close could not be verified',
      );
    }
    try {
      await persistReceipt(pendingReceipt);
    } catch (persistError) {
      throw new AggregateError(
        [error, persistError],
        `${error.message}; compensating receipt persistence failed`,
      );
    }
    throw error;
  }

  try {
    await persistReceipt(receipt);
  } catch (error) {
    let closeError;
    try {
      await setPaymentLinkActive({
        fetchImpl, key, paymentLinkId: stripe.payment_link_id, active: false,
      });
    } catch (failure) {
      closeError = failure;
    }
    if (closeError) {
      throw new AggregateError(
        [error, closeError],
        `${error.message}; verified receipt failed and compensating close failed`,
      );
    }
    try {
      await persistReceipt({
        ...activationReceipt,
        payment_link: { ...activationReceipt.payment_link, active: false },
      });
    } catch (persistError) {
      throw new AggregateError(
        [error, persistError],
        `${error.message}; compensating receipt persistence failed`,
      );
    }
    throw error;
  }
  return receipt;
}

async function readCheckoutContract({ fetchImpl, key, stripe, linkUrl, productUrl }) {
  const paymentLink = await stripeRequest({ fetchImpl, key, url: linkUrl });
  if (paymentLink.id !== stripe.payment_link_id) {
    throw new Error('Payment Link readback mismatch');
  }
  const fieldKeys = validatePaymentLink(paymentLink);
  const product = await stripeRequest({ fetchImpl, key, url: productUrl });
  validateProduct(product, stripe);
  const price = await stripeRequest({
    fetchImpl,
    key,
    url: `https://api.stripe.com/v1/prices/${stripe.price_id}`,
  });
  validatePrice(price, stripe);
  const lineItems = await stripeRequest({
    fetchImpl,
    key,
    url: `${linkUrl}/line_items?limit=2`,
  });
  validateLineItems(lineItems, stripe);
  return { paymentLink, product, price, fieldKeys };
}

function validateExistingReceipt(receipt, stripe) {
  if (receipt === undefined) return;
  if ((receipt?.verified !== false && receipt?.verified !== true)
    || !validIsoTimestamp(receipt.cutover_utc)
    || receipt.payment_link_id !== stripe.payment_link_id
    || receipt.product_id !== stripe.product_id
    || receipt.price_id !== stripe.price_id) {
    throw new Error('existing cutover receipt mismatch');
  }
}

function validateProduct(product, stripe) {
  if (product.id !== stripe.product_id
    || product.name !== PRODUCT_NAME
    || product.description !== PRODUCT_DESCRIPTION) {
    throw new Error('product readback mismatch');
  }
}

function validatePaymentLink(paymentLink) {
  if (paymentLink.after_completion?.type !== 'hosted_confirmation'
    || paymentLink.after_completion?.hosted_confirmation?.custom_message
      !== COMPLETION_MESSAGE) {
    throw new Error('completion copy readback mismatch');
  }
  return validateCustomFields(paymentLink.custom_fields);
}

function validatePrice(price, stripe) {
  if (price.id !== stripe.price_id
    || resourceId(price.product) !== stripe.product_id
    || price.active !== true
    || price.type !== 'one_time'
    || price.recurring !== null
    || price.currency !== 'gbp'
    || Number(price.custom_unit_amount?.minimum) !== 100
    || Number(price.custom_unit_amount?.maximum) !== 500000) {
    throw new Error('payment rail readback mismatch');
  }
}

function validateLineItems(lineItems, stripe) {
  const lineItem = lineItems.data?.[0];
  if (lineItems.has_more !== false
    || lineItems.data?.length !== 1
    || Number(lineItem?.quantity) !== 1
    || lineItem?.price?.id !== stripe.price_id
    || resourceId(lineItem?.price?.product) !== stripe.product_id) {
    throw new Error('line item readback mismatch');
  }
}

function validateCustomFields(fields) {
  const expected = new Map([
    ['project_name', { label: 'Project name', maximumLength: 60 }],
    ['project_url', { label: 'Project URL', maximumLength: 200 }],
  ]);
  if (!Array.isArray(fields) || fields.length !== expected.size) {
    throw new Error('custom field readback mismatch');
  }
  for (const field of fields) {
    const contract = expected.get(field.key);
    if (!contract
      || field.optional !== false
      || field.type !== 'text'
      || field.label?.type !== 'custom'
      || field.label?.custom !== contract.label
      || field.text?.default_value !== null
      || field.text?.minimum_length !== null
      || Number(field.text?.maximum_length) !== contract.maximumLength) {
      throw new Error('custom field readback mismatch');
    }
  }
  return fields.map((field) => field.key).sort();
}

function resourceId(resource) {
  return typeof resource === 'string' ? resource : resource?.id;
}

function cutoverReceipt({
  verified,
  cutoverUtc,
  stripe,
  product,
  price,
  fieldKeys,
  paymentLink,
}) {
  return {
    verified,
    cutover_utc: cutoverUtc,
    stripe_api_version: STRIPE_API_VERSION,
    payment_link_id: stripe.payment_link_id,
    product_id: stripe.product_id,
    price_id: stripe.price_id,
    product: {
      id: product.id,
      name: product.name,
      description: product.description,
    },
    payment_link: {
      id: stripe.payment_link_id,
      url: paymentLink.url,
      active: paymentLink.active,
      completion_message: COMPLETION_MESSAGE,
      custom_field_keys: fieldKeys,
      currency: price.currency,
      minimum_pence: Number(price.custom_unit_amount.minimum),
      maximum_pence: Number(price.custom_unit_amount.maximum),
    },
  };
}

export function validateCutoverAttestation(receipt, config) {
  if (receipt === undefined || receipt === null) return null;
  const fieldKeys = receipt.payment_link?.custom_field_keys;
  const validUrl = typeof receipt.payment_link?.url === 'string'
    && receipt.payment_link.url === config.payment_link_url
    && stripeHostedUrl(receipt.payment_link.url);
  if (receipt.verified !== true
    || !validIsoTimestamp(receipt.cutover_utc)
    || receipt.stripe_api_version !== STRIPE_API_VERSION
    || receipt.payment_link_id !== config.payment_link_id
    || receipt.product_id !== config.product_id
    || receipt.price_id !== config.price_id
    || receipt.product?.id !== receipt.product_id
    || receipt.product?.name !== PRODUCT_NAME
    || receipt.product?.description !== PRODUCT_DESCRIPTION
    || receipt.payment_link?.id !== receipt.payment_link_id
    || receipt.payment_link?.active !== true
    || !validUrl
    || receipt.payment_link?.completion_message !== COMPLETION_MESSAGE
    || !Array.isArray(fieldKeys)
    || fieldKeys.length !== 2
    || [...fieldKeys].sort().join(',') !== 'project_name,project_url'
    || receipt.payment_link?.currency !== config.currency
    || receipt.payment_link?.minimum_pence !== config.minimum_pence
    || receipt.payment_link?.maximum_pence !== config.maximum_pence) {
    throw new Error('cutover attestation mismatch');
  }
  return {
    cutover_utc: receipt.cutover_utc,
    payment_link_id: receipt.payment_link_id,
    payment_link_url: receipt.payment_link.url,
  };
}

function stripeHostedUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:'
      && url.hostname === 'buy.stripe.com'
      && url.pathname.length > 1
      && !url.username
      && !url.password
      && !url.search
      && !url.hash;
  } catch {
    return false;
  }
}

const LOCK_FILE_MARKER = 'BRIBEBOARD_LOCK_V2\n';

function initializeAdvisoryLock(lockPath) {
  const candidatePath = `${lockPath}.${process.pid}.${randomUUID()}.init`;
  let candidate;
  try {
    candidate = openSync(candidatePath, 'wx', 0o600);
    writeFileSync(candidate, LOCK_FILE_MARKER);
    fsyncSync(candidate);
    closeSync(candidate);
    candidate = undefined;
    try {
      linkSync(candidatePath, lockPath);
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      if (readFileSync(lockPath, 'utf8') !== LOCK_FILE_MARKER) {
        throw new Error(`legacy cutover lock requires manual recovery: ${lockPath}`);
      }
    }
  } finally {
    if (candidate !== undefined) closeSync(candidate);
    try {
      unlinkSync(candidatePath);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
}

function advisoryLockCommand() {
  if (process.platform === 'darwin') {
    return { command: '/usr/bin/lockf', args: ['-t', '0', '3'] };
  }
  if (process.platform === 'linux') {
    return { command: '/usr/bin/flock', args: ['--nonblock', '3'] };
  }
  throw new Error(`cutover advisory lock is unsupported on ${process.platform}`);
}

function acquireAdvisoryLock(lockPath) {
  initializeAdvisoryLock(lockPath);
  const { command, args } = advisoryLockCommand();
  const lock = openSync(lockPath, 'r');
  let result;
  try {
    result = spawnSync(command, args, {
      encoding: 'utf8',
      stdio: ['ignore', 'ignore', 'pipe', lock],
    });
  } catch (error) {
    closeSync(lock);
    throw error;
  }
  if (result.error) {
    closeSync(lock);
    throw result.error;
  }
  if (result.status !== 0) {
    closeSync(lock);
    throw new Error(`cutover is already locked: ${lockPath}`);
  }
  return lock;
}

export async function withCutoverLock(receiptPath, operation) {
  if (typeof operation !== 'function') {
    throw new TypeError('cutover operation must be a function');
  }
  const lock = acquireAdvisoryLock(`${receiptPath}.lock`);
  let result;
  let operationError;
  try {
    result = await operation();
  } catch (error) {
    operationError = error;
  }
  let releaseError;
  try {
    closeSync(lock);
  } catch (error) {
    releaseError = error;
  }
  if (operationError && releaseError) {
    throw new AggregateError(
      [operationError, releaseError],
      'cutover operation and lock release failed',
    );
  }
  if (operationError) throw operationError;
  if (releaseError) throw releaseError;
  return result;
}

export function writeCutoverReceipt(path, receipt) {
  const temporaryPath = `${path}.tmp`;
  let file;
  let renamed = false;
  try {
    file = openSync(temporaryPath, 'w', 0o600);
    writeFileSync(file, `${JSON.stringify(receipt, null, 2)}\n`);
    fsyncSync(file);
    closeSync(file);
    file = undefined;
    renameSync(temporaryPath, path);
    renamed = true;

    const directory = openSync(dirname(path), 'r');
    try {
      fsyncSync(directory);
    } finally {
      closeSync(directory);
    }
  } finally {
    if (file !== undefined) closeSync(file);
    if (!renamed) {
      try {
        unlinkSync(temporaryPath);
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
    }
  }
}

function validIsoTimestamp(value) {
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds)
    && new Date(milliseconds).toISOString() === value;
}

async function waitUntil(value) {
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) {
    throw new TypeError('cutover boundary is invalid');
  }
  const delay = milliseconds - Date.now();
  if (delay > 0) await new Promise((resolveDelay) => setTimeout(resolveDelay, delay));
}

function nextWholeSecond(value) {
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) {
    throw new TypeError('nowUtc returned an invalid timestamp');
  }
  return new Date((Math.floor(milliseconds / 1000) + 1) * 1000).toISOString();
}

export async function stripeRequest({
  fetchImpl,
  key,
  url,
  method,
  form,
  timeoutMs = 15000,
}) {
  const requestMethod = method || 'GET';
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const headers = {
    Authorization: `Bearer ${key}`,
    'Stripe-Version': STRIPE_API_VERSION,
  };
  const options = { headers, signal: controller.signal };
  if (method) {
    options.method = method;
    options.headers['Content-Type'] = 'application/x-www-form-urlencoded';
    options.body = new URLSearchParams(form).toString();
  }
  try {
    const response = await fetchImpl(url, options);
    const body = await response.json();
    if (!response.ok) {
      throw new Error(body.error?.message || `Stripe HTTP ${response.status}`);
    }
    const serverMilliseconds = Date.parse(response.headers?.get?.('date'));
    if (Number.isFinite(serverMilliseconds)) {
      Object.defineProperty(body, STRIPE_SERVER_UTC, {
        value: new Date(serverMilliseconds).toISOString(),
      });
    }
    return body;
  } catch (error) {
    if (controller.signal.aborted) {
      throw new Error(`Stripe ${requestMethod} timed out`);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  const command = process.argv[2];
  if (!['close', 'migrate-vibe-tax'].includes(command)) {
    console.error('usage: stripe-window.mjs close|migrate-vibe-tax');
    process.exit(1);
  }

  const here = dirname(fileURLToPath(import.meta.url));
  const root = join(here, '..', '..');
  const key = readFileSync(join(root, '.env'), 'utf8')
    .match(/^STRIPE_RESTRICTED_KEY=(\S+)/m)?.[1];
  if (!key) throw new Error('no STRIPE_RESTRICTED_KEY');
  const stripe = JSON.parse(readFileSync(join(here, 'stripe.json'), 'utf8'));

  if (command === 'close') {
    const result = await setPaymentLinkActive({
      fetchImpl: fetch,
      key,
      paymentLinkId: stripe.payment_link_id,
      active: false,
    });
    console.log(JSON.stringify(result));
  } else {
    const receiptPath = join(here, 'stripe-cutover.json');
    const receipt = await withCutoverLock(receiptPath, async () => {
      let existingReceipt;
      try {
        existingReceipt = JSON.parse(readFileSync(receiptPath, 'utf8'));
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }

      return migrateVibeTax({
        fetchImpl: fetch,
        key,
        stripe,
        persistReceipt: async (value) => {
          writeCutoverReceipt(receiptPath, value);
        },
        existingReceipt,
      });
    });
    console.log(JSON.stringify(receipt));
  }
}
