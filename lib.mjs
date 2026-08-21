// bribeboard core rules. Pure functions, no IO, fully covered by test.mjs.
// The board is computed from the public payment book by exactly this code.

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

const TRACKING_PARAMS = /^(utm_|ref$|fbclid$|gclid$|aff|affiliate)/;

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
  let host = u.hostname.toLowerCase();
  if (host.startsWith('www.')) host = host.slice(4);
  if (!host.includes('.')) return { ok: false, reason: 'no-tld' };
  if (SHORTENERS.has(host)) return { ok: false, reason: 'shortener' };
  if (BANNED_HOSTS.has(host)) return { ok: false, reason: 'invite-link' };
  for (const b of BANNED_PATH_PREFIXES) {
    if (host === b.host && u.pathname.startsWith(b.prefix)) {
      return { ok: false, reason: 'invite-link' };
    }
  }
  const params = new URLSearchParams();
  for (const [k, v] of u.searchParams) {
    if (!TRACKING_PARAMS.test(k.toLowerCase())) params.append(k, v);
  }
  let path = u.pathname.replace(/\/+$/, '');
  const q = params.toString();
  const display = `https://${host}${path}${q ? '?' + q : ''}`;
  const identity = `${host}${path.toLowerCase()}`;
  return { ok: true, identity, display };
}

export function sanitizeName(raw) {
  if (typeof raw !== 'string') return '';
  return raw.replace(/[\x00-\x1f\x7f]/g, '').trim().slice(0, 60);
}

// payments: [{id, amount, refunded, currency, created, url_raw, name_raw}]
// amounts in minor units (pence). Returns ranked listings plus the excluded
// book. Rank = net total paid, desc; ties break by earlier first payment.
export function aggregate(payments) {
  const groups = new Map();
  const excluded = [];
  for (const p of [...payments].sort((a, b) => a.created - b.created)) {
    const net = (p.amount || 0) - (p.refunded || 0);
    const norm = normalizeUrl(p.url_raw);
    if (!norm.ok) {
      excluded.push({
        id: p.id,
        amount: p.amount,
        refunded: p.refunded || 0,
        created: p.created,
        name: sanitizeName(p.name_raw),
        reason: norm.reason,
      });
      continue;
    }
    let g = groups.get(norm.identity);
    if (!g) {
      g = {
        identity: norm.identity,
        url: norm.display,
        name: sanitizeName(p.name_raw),
        total: 0,
        first_created: p.created,
        payments: [],
      };
      groups.set(norm.identity, g);
    }
    g.total += net;
    const name = sanitizeName(p.name_raw);
    if (name) g.name = name; // latest payment names the listing
    g.payments.push({
      id: p.id,
      amount: p.amount,
      refunded: p.refunded || 0,
      created: p.created,
    });
  }
  const listings = [...groups.values()]
    .filter((g) => g.total > 0)
    .sort((a, b) => b.total - a.total || a.first_created - b.first_created);
  listings.forEach((g, i) => { g.rank = i + 1; });
  return { listings, excluded };
}

export function gbp(pence) {
  const pounds = pence / 100;
  const s = pounds.toLocaleString('en-GB', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  return `£${s}`;
}

export function median(values) {
  if (!values.length) return 0;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : Math.round((s[mid - 1] + s[mid]) / 2);
}

export function escapeHtml(s) {
  return String(s)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}
