// Vibe Revenue Service core rules. Pure functions, no IO.
// The public register is computed from the sanitized payment book by this code.
import { createHash } from 'node:crypto';

const SHORTENERS = new Set([
  'bit.ly', 't.co', 'tinyurl.com', 'goo.gl', 'is.gd', 'buff.ly',
  'short.io', 'cutt.ly', 'tiny.cc', 'rb.gy', 'ow.ly', 's.id',
]);

const BANNED_HOSTS = new Set([
  'discord.gg', 't.me', 'wa.me', 'chat.whatsapp.com',
]);

const BANNED_PATH_PREFIXES = [
  { host: 'discord.com', prefix: '/invite' },
];

const TRACKING_PARAMS = /^(utm_|ref$|referral$|partner(?:_id|id)?$|fbclid$|gclid$|dclid$|gbraid$|wbraid$|msclkid$|twclid$|igshid$|mc_cid$|mc_eid$|_ga$|_gl$|li_fat_id$|vero_id$|oly_anon_id$|oly_enc_id$|aff|affiliate)/;

export const STATUTES = Object.freeze([
  Object.freeze({ code: 'SECTION 1', title: 'UNLICENSED SHIPPING', fictional: true }),
  Object.freeze({ code: 'SECTION 7', title: 'POSSESSION OF A CUSTOM DOMAIN WITH INTENT TO LAUNCH', fictional: true }),
  Object.freeze({ code: 'SECTION 13', title: 'EXCESSIVE OPTIMISM', fictional: true }),
  Object.freeze({ code: 'SECTION 21', title: 'OPERATING A BUTTON BEFORE REVENUE', fictional: true }),
  Object.freeze({ code: 'SECTION 37', title: 'FAILURE TO REMAIN A WEEKEND PROJECT', fictional: true }),
  Object.freeze({ code: 'SECTION 42', title: 'CROSS-BORDER GRADIENT ACTIVITY', fictional: true }),
  Object.freeze({ code: 'SECTION 69', title: 'UNDECLARED MICRO-SAAS ACTIVITY', fictional: true }),
  Object.freeze({ code: 'SECTION 404', title: 'ATTEMPTED PRODUCT-MARKET FIT', fictional: true }),
]);

const BRACKETS = Object.freeze([
  { key: 'micro-entity', title: 'MICRO ENTITY', min: 100, max: 499 },
  { key: 'side-project-in-trade', title: 'SIDE PROJECT IN TRADE', min: 500, max: 1999 },
  { key: 'revenue-adjacent-body', title: 'REVENUE-ADJACENT BODY', min: 2000, max: 9999 },
  { key: 'vibe-corporation', title: 'VIBE CORPORATION', min: 10000, max: 49999 },
  { key: 'systemic-vibe-concern', title: 'SYSTEMIC VIBE CONCERN', min: 50000, max: 499999 },
  { key: 'too-vibe-to-fail', title: 'TOO VIBE TO FAIL', min: 500000, max: 500000 },
]);

const PUBLIC_REASONS = new Set([
  'policy', 'pre-cutover', 'amount-range', 'currency', 'invalid-url',
  'invalid-code', 'refund-range', 'dispute-range', 'moderation',
]);

export function normalizeUrl(raw) {
  if (typeof raw !== 'string') return { ok: false, reason: 'empty' };
  let s = raw.trim();
  if (!s) return { ok: false, reason: 'empty' };
  if (!/^https?:\/\//i.test(s)) s = 'https://' + s;
  let u;
  try {
    u = new URL(s);
  } catch {
    return { ok: false, reason: 'unparseable' };
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') {
    return { ok: false, reason: 'scheme' };
  }
  const hostname = u.hostname.toLowerCase();
  const policyHostname = hostname.startsWith('www.') ? hostname.slice(4) : hostname;
  if (!hostname.includes('.')) return { ok: false, reason: 'no-tld' };
  if (SHORTENERS.has(policyHostname)) return { ok: false, reason: 'shortener' };
  if (BANNED_HOSTS.has(policyHostname)) return { ok: false, reason: 'invite-link' };
  for (const banned of BANNED_PATH_PREFIXES) {
    if (policyHostname === banned.host && u.pathname.startsWith(banned.prefix)) {
      return { ok: false, reason: 'invite-link' };
    }
  }
  const entries = [...u.searchParams]
    .filter(([key]) => !TRACKING_PARAMS.test(key.toLowerCase()))
    .sort(([keyA, valueA], [keyB, valueB]) =>
      keyA.localeCompare(keyB) || valueA.localeCompare(valueB));
  const params = new URLSearchParams(entries);
  const path = u.pathname.replace(/\/+$/, '');
  const query = params.toString();
  const host = `${hostname}${u.port ? `:${u.port}` : ''}`;
  const canonical = `${u.protocol}//${host}${path}${query ? '?' + query : ''}`;
  return { ok: true, identity: canonical, display: canonical };
}

export function sanitizeName(raw) {
  if (typeof raw !== 'string') return '';
  return raw.replace(/[\x00-\x1f\x7f]/g, '').trim().slice(0, 60);
}

export function filingCode(sessionId) {
  if (typeof sessionId !== 'string' || !sessionId) {
    throw new TypeError('sessionId must be a non-empty string');
  }
  const digest = createHash('sha256').update(sessionId).digest('hex');
  return `V-${digest.slice(0, 32).toUpperCase()}`;
}

export function taxBracket(grossPence) {
  if (!Number.isInteger(grossPence)) return null;
  const bracket = BRACKETS.find(({ min, max }) => grossPence >= min && grossPence <= max);
  return bracket ? { key: bracket.key, title: bracket.title } : null;
}

export function buildRegister(publicPayments) {
  const filings = [];
  const pending = [];
  const excluded = [];
  const money = [];
  const seenCodes = new Set();

  const payments = [...(Array.isArray(publicPayments) ? publicPayments : [])]
    .sort((a, b) => numeric(a.created) - numeric(b.created)
      || String(a.filing_code || '').localeCompare(String(b.filing_code || '')));

  for (const payment of payments) {
    const code = validCode(payment.filing_code) ? payment.filing_code : null;
    const amountPence = numeric(payment.amount);
    const disputedPence = payment.disputed_pence === undefined
      ? payment.disputed ? amountPence : 0
      : numeric(payment.disputed_pence);
    const disputeLossPence = payment.dispute_loss_pence === undefined
      ? disputedPence
      : numeric(payment.dispute_loss_pence);
    const disputed = payment.disputed === true || disputedPence > 0;
    const base = {
      code,
      amount_pence: amountPence,
      refunded_pence: numeric(payment.refunded),
      disputed,
      disputed_pence: disputedPence,
      dispute_status: disputed ? String(payment.dispute_status || 'unknown') : null,
      dispute_loss_pence: disputeLossPence,
      created: numeric(payment.created),
    };

    if (!code) {
      excluded.push({ ...base, reason: 'invalid-code' });
      continue;
    }
    if (seenCodes.has(code)) {
      throw new Error(`duplicate filing code: ${code}`);
    }
    seenCodes.add(code);
    if (payment.moderation === 'legacy') {
      excluded.push({ ...base, reason: 'pre-cutover' });
      continue;
    }
    if (payment.currency !== 'gbp') {
      excluded.push({ ...base, reason: 'currency' });
      continue;
    }
    const bracket = taxBracket(base.amount_pence);
    if (!bracket) {
      excluded.push({ ...base, reason: 'amount-range' });
      continue;
    }
    if (!Number.isInteger(base.refunded_pence)
      || base.refunded_pence < 0
      || base.refunded_pence > base.amount_pence) {
      excluded.push({ ...base, reason: 'refund-range' });
      continue;
    }
    if (!Number.isInteger(base.disputed_pence)
      || !Number.isInteger(base.dispute_loss_pence)
      || base.disputed_pence < 0
      || base.disputed_pence > base.amount_pence
      || base.dispute_loss_pence < 0
      || base.dispute_loss_pence > base.disputed_pence) {
      excluded.push({ ...base, reason: 'dispute-range' });
      continue;
    }

    const retained = Math.max(
      0,
      base.amount_pence - base.refunded_pence - base.dispute_loss_pence,
    );
    money.push({ ...base, retained_pence: retained });

    if (payment.moderation === 'pending') {
      pending.push(base);
      continue;
    }
    if (payment.moderation === 'rejected') {
      excluded.push({ ...base, reason: publicReason(payment.reason) });
      continue;
    }

    const removed = payment.moderation === 'removed';
    if (!removed && payment.moderation !== 'approved') {
      excluded.push({ ...base, reason: 'moderation' });
      continue;
    }

    const norm = removed ? null : normalizeUrl(payment.url);
    if (!removed && !norm.ok) {
      excluded.push({ ...base, reason: 'invalid-url' });
      continue;
    }

    const status = removed
      ? 'REMOVED'
      : base.disputed || retained === 0
        ? 'VOID'
        : base.refunded_pence > 0
          ? 'AMENDED'
          : 'RECEIVED';
    const statuteIndex = parseInt(
      createHash('sha256').update(code).digest('hex').slice(0, 8),
      16,
    ) % STATUTES.length;

    filings.push({
      ...base,
      slug: code.toLowerCase(),
      status,
      retained_pence: retained,
      name: removed ? null : sanitizeName(payment.name) || norm.display,
      url: removed ? null : norm.display,
      identity: removed ? null : norm.identity,
      bracket,
      statute: STATUTES[statuteIndex],
    });
  }

  const active = filings.filter((filing) =>
    filing.status === 'RECEIVED' || filing.status === 'AMENDED');
  const totals = {
    gross_pence: money.reduce((sum, entry) => sum + entry.amount_pence, 0),
    refunded_pence: money.reduce((sum, entry) => sum + entry.refunded_pence, 0),
    disputed_pence: money.reduce((sum, entry) => sum + entry.disputed_pence, 0),
    retained_pence: money.reduce((sum, entry) => sum + entry.retained_pence, 0),
    valid_retained_pence: active.reduce((sum, filing) => sum + filing.retained_pence, 0),
    certificate_count: filings.length,
    filing_count: active.length,
    distinct_project_count: new Set(active.map((filing) => filing.identity)).size,
  };

  return { filings, pending, excluded, totals };
}

function validCode(value) {
  return typeof value === 'string' && /^V-[A-F0-9]{32}$/.test(value);
}

function publicReason(value) {
  return PUBLIC_REASONS.has(value) ? value : 'policy';
}

function numeric(value) {
  return Number.isFinite(value) ? Number(value) : 0;
}

export function gbp(pence) {
  const pounds = pence / 100;
  const formatted = pounds.toLocaleString('en-GB', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  return `£${formatted}`;
}

export function median(values) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? sorted[middle]
    : Math.round((sorted[middle - 1] + sorted[middle]) / 2);
}

export function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}
