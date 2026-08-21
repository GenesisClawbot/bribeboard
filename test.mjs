import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeUrl, sanitizeName, aggregate, gbp, median, escapeHtml } from './lib.mjs';

test('normalizeUrl adds https and strips www', () => {
  const r = normalizeUrl('www.Example.com/My-App');
  assert.equal(r.ok, true);
  assert.equal(r.display, 'https://example.com/My-App');
  assert.equal(r.identity, 'example.com/my-app');
});

test('normalizeUrl strips trailing slash and hash', () => {
  const r = normalizeUrl('https://foo.dev/app/#top');
  assert.equal(r.display, 'https://foo.dev/app');
});

test('normalizeUrl strips tracking params, keeps real ones', () => {
  const r = normalizeUrl('https://foo.dev/a?utm_source=x&ref=y&id=3&affiliate=z&fbclid=1');
  assert.equal(r.display, 'https://foo.dev/a?id=3');
});

test('normalizeUrl rejects shorteners', () => {
  assert.equal(normalizeUrl('https://bit.ly/abc').reason, 'shortener');
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

test('aggregate groups by identity and sums top-ups', () => {
  const { listings } = aggregate([
    { id: 'a', amount: 500, created: 1, url_raw: 'foo.dev', name_raw: 'Foo' },
    { id: 'b', amount: 300, created: 2, url_raw: 'https://www.foo.dev/', name_raw: 'Foo!' },
    { id: 'c', amount: 600, created: 3, url_raw: 'bar.dev', name_raw: 'Bar' },
  ]);
  assert.equal(listings.length, 2);
  assert.equal(listings[0].identity, 'foo.dev');
  assert.equal(listings[0].total, 800);
  assert.equal(listings[0].rank, 1);
  assert.equal(listings[0].name, 'Foo!');
  assert.equal(listings[1].total, 600);
});

test('aggregate subtracts refunds and drops fully refunded', () => {
  const { listings } = aggregate([
    { id: 'a', amount: 500, refunded: 500, created: 1, url_raw: 'gone.dev', name_raw: 'g' },
    { id: 'b', amount: 500, refunded: 100, created: 2, url_raw: 'kept.dev', name_raw: 'k' },
  ]);
  assert.equal(listings.length, 1);
  assert.equal(listings[0].total, 400);
});

test('aggregate breaks ties by earlier first payment', () => {
  const { listings } = aggregate([
    { id: 'b', amount: 500, created: 2, url_raw: 'late.dev', name_raw: 'late' },
    { id: 'a', amount: 500, created: 1, url_raw: 'early.dev', name_raw: 'early' },
  ]);
  assert.equal(listings[0].identity, 'early.dev');
  assert.equal(listings[1].identity, 'late.dev');
});

test('aggregate books banned urls as excluded with reason', () => {
  const { listings, excluded } = aggregate([
    { id: 'a', amount: 500, created: 1, url_raw: 'https://bit.ly/x', name_raw: 'sneaky' },
  ]);
  assert.equal(listings.length, 0);
  assert.equal(excluded.length, 1);
  assert.equal(excluded[0].reason, 'shortener');
  assert.equal(excluded[0].amount, 500);
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
