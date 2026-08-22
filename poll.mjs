#!/usr/bin/env node
// Reads paid Checkout Sessions, keeps unmoderated project strings local, and
// writes a sanitized public payment book into the board checkout.
import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { filingCode, normalizeUrl, sanitizeName } from './lib.mjs';
import {
  stripeRequest,
  validateCutoverAttestation,
  withCutoverLock,
} from './stripe-window.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const DISPUTE_STATUSES = new Set([
  'needs_response', 'under_review', 'won', 'lost', 'prevented',
  'warning_needs_response', 'warning_under_review', 'warning_closed',
]);
const DISPUTE_NO_LOSS = new Set([
  'won', 'prevented',
  'warning_needs_response', 'warning_under_review', 'warning_closed',
]);

export function toPublicPayment(session, decision, cutoverUnix, previous) {
  if (session?.status !== 'complete' || session?.payment_status !== 'paid') {
    return null;
  }

  const code = filingCode(session.id);
  const charge = session.payment_intent?.latest_charge;
  if (!charge || typeof charge !== 'object'
    || !Number.isInteger(charge.amount_refunded)
    || typeof charge.disputed !== 'boolean') {
    throw new Error('expanded charge details missing');
  }
  const dispute = charge.disputed ? charge.dispute : null;
  if (charge.disputed && (!Number.isInteger(dispute?.amount)
    || !DISPUTE_STATUSES.has(dispute?.status)
    || !Array.isArray(dispute?.balance_transactions)
    || dispute.balance_transactions.some(({ amount }) => !Number.isInteger(amount)))) {
    throw new Error('expanded dispute details missing');
  }
  if (charge.disputed && dispute.balance_transactions.some(({ currency }) =>
    String(currency || '').toLowerCase() !== String(session.currency || '').toLowerCase())) {
    throw new Error('dispute balance currency mismatch');
  }
  const disputedPence = dispute?.amount || 0;
  const disputeStatus = dispute?.status || null;
  const balanceEffect = dispute?.balance_transactions
    .reduce((sum, transaction) => sum + transaction.amount, 0) || 0;
  const disputeLossPence = DISPUTE_NO_LOSS.has(disputeStatus)
    ? 0
    : Math.min(disputedPence, Math.max(0, -balanceEffect));
  const record = {
    filing_code: code,
    amount: integer(session.amount_total),
    refunded: integer(charge?.amount_refunded),
    disputed: disputedPence > 0,
    disputed_pence: disputedPence,
    dispute_status: disputeStatus,
    dispute_loss_pence: disputeLossPence,
    currency: String(session.currency || '').toLowerCase(),
    created: integer(session.created),
    created_utc: new Date(integer(session.created) * 1000).toISOString(),
  };

  if (!Number.isFinite(cutoverUnix) || record.created < cutoverUnix) {
    return { ...record, moderation: 'legacy', reason: 'pre-cutover' };
  }

  if (previous?.moderation === 'approved') {
    if (decision?.status === 'removed') {
      return { ...record, moderation: 'removed' };
    }
    if (decision && decision.status !== 'approved') {
      throw new Error(`invalid moderation transition for ${code}`);
    }
    if (typeof previous.name !== 'string' || typeof previous.url !== 'string') {
      throw new Error(`invalid previous public filing ${code}`);
    }
    return {
      ...record,
      moderation: 'approved',
      name: previous.name,
      url: previous.url,
    };
  }
  if (previous?.moderation === 'removed' || previous?.moderation === 'rejected') {
    if (decision && decision.status !== previous.moderation) {
      throw new Error(`invalid moderation transition for ${code}`);
    }
    return previous.moderation === 'rejected'
      ? { ...record, moderation: 'rejected', reason: 'policy' }
      : { ...record, moderation: 'removed' };
  }

  if (decision?.status === 'removed') {
    return { ...record, moderation: 'removed' };
  }
  if (decision?.status === 'rejected') {
    return { ...record, moderation: 'rejected', reason: 'policy' };
  }
  if (decision?.status === 'approved') {
    const normalized = normalizeUrl(decision.url);
    if (normalized.ok) {
      return {
        ...record,
        moderation: 'approved',
        name: sanitizeName(decision.name) || normalized.display,
        url: normalized.display,
      };
    }
  }
  return { ...record, moderation: 'pending' };
}

export function cutoverUnixFromAttestation(config, receipt, previousCutoverUtc = null) {
  const attestation = validateCutoverAttestation(receipt, config);
  if (attestation === null
    && previousCutoverUtc !== null
    && previousCutoverUtc !== undefined) {
    throw new Error('verified cutover receipt disappeared');
  }
  return attestation === null ? null : Date.parse(attestation.cutover_utc) / 1000;
}

export function buildPublicBook({
  sessions,
  moderation,
  previousPayments,
  cutoverUnix,
  pulledUtc,
}) {
  const previous = Array.isArray(previousPayments) ? previousPayments : [];
  const previousCodes = previous
    .map((payment) => payment?.filing_code)
    .filter((code) => typeof code === 'string');
  if (new Set(previousCodes).size !== previousCodes.length) {
    throw new Error('duplicate filing code in previous payment book');
  }
  const previousByCode = new Map(
    previous.map((payment) => [payment?.filing_code, payment]),
  );
  const payments = (Array.isArray(sessions) ? sessions : [])
    .map((session) => {
      const code = typeof session?.id === 'string' ? filingCode(session.id) : null;
      return toPublicPayment(
        session,
        code ? moderation?.[code] : undefined,
        cutoverUnix,
        code ? previousByCode.get(code) : undefined,
      );
    })
    .filter(Boolean)
    .sort((a, b) => a.created - b.created || a.filing_code.localeCompare(b.filing_code));
  const paymentCodes = payments.map((payment) => payment.filing_code);
  if (new Set(paymentCodes).size !== paymentCodes.length) {
    throw new Error('duplicate paid Session');
  }
  const currentCodes = new Set(paymentCodes);
  const missing = [...previousByCode.keys()]
    .filter((code) => typeof code === 'string' && !currentCodes.has(code));
  if (missing.length) {
    throw new Error(`known paid Session disappeared: ${missing.sort().join(', ')}`);
  }

  return {
    rule_version: 'vibe-tax-v1',
    cutover_utc: Number.isFinite(cutoverUnix)
      ? new Date(cutoverUnix * 1000).toISOString()
      : null,
    pulled_utc: pulledUtc,
    payments,
  };
}

export function buildModerationInbox(sessions, moderation, cutoverUnix) {
  const inbox = [];
  for (const session of Array.isArray(sessions) ? sessions : []) {
    if (session?.status !== 'complete' || session?.payment_status !== 'paid') continue;
    if (!Number.isFinite(cutoverUnix) || integer(session.created) < cutoverUnix) continue;
    const code = filingCode(session.id);
    const decision = moderation?.[code];
    if (moderationResolved(decision)) continue;
    const fields = Object.fromEntries(
      (session.custom_fields || []).map((field) => [field.key, field.text?.value || '']),
    );
    inbox.push({
      filing_code: code,
      amount_pence: integer(session.amount_total),
      paid_utc: new Date(integer(session.created) * 1000).toISOString(),
      name_raw: clean(fields.project_name).slice(0, 60),
      url_raw: clean(fields.project_url).slice(0, 200),
    });
  }
  return inbox.sort((a, b) => a.paid_utc.localeCompare(b.paid_utc)
    || a.filing_code.localeCompare(b.filing_code));
}

function moderationResolved(decision) {
  if (!decision || decision.status === 'pending') return false;
  if (decision.status === 'approved') return normalizeUrl(decision.url).ok;
  return decision.status === 'rejected' || decision.status === 'removed';
}

function integer(value) {
  return Number.isInteger(value) ? value : 0;
}

function clean(value) {
  return String(value || '').replace(/[\x00-\x1f\x7f]/g, '').trim();
}

export async function stripeGet({
  fetchImpl = fetch,
  key,
  path,
  timeoutMs,
}) {
  return stripeRequest({
    fetchImpl,
    key,
    url: `https://api.stripe.com/v1/${path}`,
    timeoutMs,
  });
}

export async function withPollLock(boardDir, operation) {
  try {
    return await withCutoverLock(join(boardDir, 'payments.json'), operation);
  } catch (error) {
    if (error?.message?.startsWith('cutover is already locked:')) {
      throw new Error(`poll is already locked: ${boardDir}`);
    }
    throw error;
  }
}

async function pollBoard(boardDir) {
  const root = join(here, '..', '..');
  const config = JSON.parse(readFileSync(join(boardDir, 'board-config.json'), 'utf8'));
  let previousPayments = [];
  let previousCutoverUtc = null;
  try {
    const previousBook = JSON.parse(readFileSync(join(boardDir, 'payments.json'), 'utf8'));
    previousPayments = Array.isArray(previousBook.payments) ? previousBook.payments : [];
    previousCutoverUtc = previousBook.cutover_utc ?? null;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  if (!config.payment_link_id) {
    throw new Error('board-config.json has no payment_link_id');
  }
  let receipt = null;
  try {
    receipt = JSON.parse(readFileSync(join(boardDir, 'stripe-cutover.json'), 'utf8'));
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const cutoverUnix = cutoverUnixFromAttestation(config, receipt, previousCutoverUtc);
  let moderation = {};
  try {
    moderation = JSON.parse(readFileSync(join(here, 'moderation.json'), 'utf8'));
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const key = readFileSync(join(root, '.env'), 'utf8')
    .match(/^STRIPE_RESTRICTED_KEY=(\S+)/m)?.[1];
  if (!key) throw new Error('no STRIPE_RESTRICTED_KEY');

  const sessions = [];
  let cursor = null;
  for (;;) {
    const query = new URLSearchParams({
      payment_link: config.payment_link_id,
      limit: '100',
      'expand[]': 'data.payment_intent.latest_charge',
    });
    query.append('expand[]', 'data.payment_intent.latest_charge.dispute');
    if (cursor) query.set('starting_after', cursor);
    const page = await stripeGet({ key, path: `checkout/sessions?${query}` });
    sessions.push(...page.data);
    if (!page.has_more) break;
    cursor = page.data.at(-1).id;
  }

  const pulledUtc = new Date().toISOString();
  const book = buildPublicBook({
    sessions,
    moderation,
    previousPayments,
    cutoverUnix,
    pulledUtc,
  });
  const inbox = buildModerationInbox(sessions, moderation, cutoverUnix);
  writeFileSync(join(boardDir, 'payments.json'), JSON.stringify(book, null, 2) + '\n');
  writeFileSync(
    join(here, 'moderation-inbox.json'),
    JSON.stringify({ pulled_utc: pulledUtc, filings: inbox }, null, 2) + '\n',
  );

  const counts = book.payments.reduce((result, payment) => {
    result[payment.moderation] = (result[payment.moderation] || 0) + 1;
    return result;
  }, {});
  console.log(JSON.stringify({ sessions: sessions.length, paid: book.payments.length, ...counts }));
}

async function run() {
  const boardDir = process.argv[2];
  if (!boardDir) {
    console.error('usage: poll.mjs <board-checkout-dir>');
    process.exitCode = 1;
    return;
  }
  await withPollLock(boardDir, () => pollBoard(boardDir));
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) await run();
