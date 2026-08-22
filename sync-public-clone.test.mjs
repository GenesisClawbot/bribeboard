import test from 'node:test';
import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { syncPublicClone } from './sync-public-clone.mjs';

test('syncPublicClone replaces owned product files and keeps unrelated files', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'vibe-tax-sync-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const source = join(root, 'source');
  const target = join(root, 'target');
  mkdirSync(join(source, 'docs', 'filings', 'h-001'), { recursive: true });
  makeGitClone(target);
  mkdirSync(join(target, 'docs', 'filings', 'stale'), { recursive: true });

  for (const file of [
    '.gitignore',
    'README.md',
    'board-config.json',
    'house.json',
    'lib.mjs',
    'moderation.example.json',
    'payments.json',
    'poll.mjs',
    'poll.test.mjs',
    'render.mjs',
    'render.test.mjs',
    'stripe-window.mjs',
    'stripe-window.test.mjs',
    'sync-public-clone.mjs',
    'sync-public-clone.test.mjs',
    'test.mjs',
  ]) {
    writeFileSync(join(source, file), `new ${file}\n`);
  }
  writeFileSync(join(source, 'docs', 'index.html'), 'new index\n');
  writeFileSync(join(source, 'docs', 'data.json'), '{}\n');
  writeFileSync(join(source, 'docs', 'filings', 'h-001', 'index.html'), 'new filing\n');
  writeFileSync(join(target, 'README.md'), 'old readme\n');
  writeFileSync(join(target, 'docs', 'filings', 'stale', 'index.html'), 'stale\n');
  writeFileSync(join(target, 'verdicts.json'), '{}\n');
  writeFileSync(join(target, 'moderation.json'), '{}\n');
  writeFileSync(join(target, 'LICENSE'), 'keep me\n');

  const result = syncPublicClone({ sourceDir: source, targetDir: target });

  assert.equal(readFileSync(join(target, 'README.md'), 'utf8'), 'new README.md\n');
  assert.equal(
    readFileSync(join(target, 'docs', 'filings', 'h-001', 'index.html'), 'utf8'),
    'new filing\n',
  );
  assert.equal(existsSync(join(target, 'docs', 'filings', 'stale')), false);
  assert.equal(existsSync(join(target, 'verdicts.json')), false);
  assert.equal(existsSync(join(target, 'moderation.json')), false);
  assert.equal(readFileSync(join(target, 'LICENSE'), 'utf8'), 'keep me\n');
  assert.equal(result.copied_files, 19);
  assert.deepEqual(result.removed_files, ['moderation.json', 'verdicts.json']);
});

test('syncPublicClone mirrors the optional cutover attestation exactly', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'vibe-tax-sync-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const source = join(root, 'source');
  const target = join(root, 'target');
  makeCompleteSource(source);
  makeGitClone(target);
  const sourceReceipt = join(source, 'stripe-cutover.json');
  const targetReceipt = join(target, 'stripe-cutover.json');
  writeFileSync(sourceReceipt, '{"verified":true}\n');

  syncPublicClone({ sourceDir: source, targetDir: target });
  assert.equal(readFileSync(targetReceipt, 'utf8'), '{"verified":true}\n');

  rmSync(sourceReceipt);
  syncPublicClone({ sourceDir: source, targetDir: target });
  assert.equal(existsSync(targetReceipt), false);
});

test('syncPublicClone refuses a target that is not a git clone', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'vibe-tax-sync-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const source = join(root, 'source');
  const target = join(root, 'target');
  mkdirSync(source);
  mkdirSync(target);

  assert.throws(
    () => syncPublicClone({ sourceDir: source, targetDir: target }),
    /target is not a git clone/,
  );
});

test('syncPublicClone refuses to delete a non-empty legacy verdict book', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'vibe-tax-sync-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const source = join(root, 'source');
  const target = join(root, 'target');
  mkdirSync(source);
  makeGitClone(target);
  writeFileSync(join(target, 'verdicts.json'), '{"V-ONE":"keep"}\n');

  assert.throws(
    () => syncPublicClone({ sourceDir: source, targetDir: target }),
    /legacy verdict book is not empty/,
  );
  assert.equal(
    readFileSync(join(target, 'verdicts.json'), 'utf8'),
    '{"V-ONE":"keep"}\n',
  );
});

test('syncPublicClone refuses a non-Bribeboard remote', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'vibe-tax-sync-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const source = join(root, 'source');
  const target = join(root, 'target');
  mkdirSync(source);
  makeGitClone(target, 'https://github.com/GenesisClawbot/other.git');

  assert.throws(
    () => syncPublicClone({ sourceDir: source, targetDir: target }),
    /target is not the Bribeboard clone/,
  );
});

test('syncPublicClone refuses a target that contains the source', (t) => {
  const target = mkdtempSync(join(tmpdir(), 'vibe-tax-sync-'));
  t.after(() => rmSync(target, { recursive: true, force: true }));
  const source = join(target, 'initiatives', 'bribeboard');
  mkdirSync(source, { recursive: true });
  makeGitClone(target);

  assert.throws(
    () => syncPublicClone({ sourceDir: source, targetDir: target }),
    /target overlaps the source tree/,
  );
});

test('syncPublicClone refuses a target inside the source', (t) => {
  const source = mkdtempSync(join(tmpdir(), 'vibe-tax-sync-'));
  t.after(() => rmSync(source, { recursive: true, force: true }));
  const target = join(source, 'public-clone');
  makeGitClone(target);

  assert.throws(
    () => syncPublicClone({ sourceDir: source, targetDir: target }),
    /target overlaps the source tree/,
  );
});

test('syncPublicClone verifies remote.origin.url rather than a decoy remote', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'vibe-tax-sync-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const source = join(root, 'source');
  const target = join(root, 'target');
  mkdirSync(source);
  makeGitClone(target);
  writeFileSync(join(target, '.git', 'config'), [
    '[remote "decoy"]',
    '\turl = https://github.com/GenesisClawbot/bribeboard.git',
    '[remote "origin"]',
    '\turl = https://github.com/example/other.git',
    '',
  ].join('\n'));
  writeFileSync(join(target, 'README.md'), 'must remain\n');

  assert.throws(
    () => syncPublicClone({ sourceDir: source, targetDir: target }),
    /target is not the Bribeboard clone/,
  );
  assert.equal(readFileSync(join(target, 'README.md'), 'utf8'), 'must remain\n');
});

test('syncPublicClone rejects a symlink alias to the source before mutation', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'vibe-tax-sync-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const source = join(root, 'source');
  const target = join(root, 'target-alias');
  makeCompleteSource(source);
  makeGitClone(source);
  symlinkSync(source, target);
  const certificate = join(source, 'docs', 'filings', 'h-001', 'index.html');

  assert.throws(
    () => syncPublicClone({ sourceDir: source, targetDir: target }),
    /target overlaps the source tree/,
  );
  assert.equal(readFileSync(certificate, 'utf8'), 'new filing\n');
});

test('syncPublicClone rejects a broken symlink at an owned path', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'vibe-tax-sync-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const source = join(root, 'source');
  const target = join(root, 'target');
  const outside = join(root, 'outside-readme.md');
  makeCompleteSource(source);
  makeGitClone(target);
  symlinkSync(outside, join(target, 'README.md'));

  assert.throws(
    () => syncPublicClone({ sourceDir: source, targetDir: target }),
    /owned path is a symlink/,
  );
  assert.equal(existsSync(outside), false);
});

test('syncPublicClone refuses to delete a non-empty moderation book', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'vibe-tax-sync-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const source = join(root, 'source');
  const target = join(root, 'target');
  mkdirSync(source);
  makeGitClone(target);
  const privateDecision = '{"V-PRIVATE":{"status":"rejected","url":"secret.test"}}\n';
  writeFileSync(join(target, 'moderation.json'), privateDecision);

  assert.throws(
    () => syncPublicClone({ sourceDir: source, targetDir: target }),
    /moderation book is not empty/,
  );
  assert.equal(readFileSync(join(target, 'moderation.json'), 'utf8'), privateDecision);
});

function makeCompleteSource(source) {
  mkdirSync(join(source, 'docs', 'filings', 'h-001'), { recursive: true });
  for (const file of [
    '.gitignore',
    'README.md',
    'board-config.json',
    'house.json',
    'lib.mjs',
    'moderation.example.json',
    'payments.json',
    'poll.mjs',
    'poll.test.mjs',
    'render.mjs',
    'render.test.mjs',
    'stripe-window.mjs',
    'stripe-window.test.mjs',
    'sync-public-clone.mjs',
    'sync-public-clone.test.mjs',
    'test.mjs',
  ]) {
    writeFileSync(join(source, file), `new ${file}\n`);
  }
  writeFileSync(join(source, 'docs', 'index.html'), 'new index\n');
  writeFileSync(join(source, 'docs', 'data.json'), '{}\n');
  writeFileSync(join(source, 'docs', 'filings', 'h-001', 'index.html'), 'new filing\n');
}

function makeGitClone(target, remote = 'https://github.com/GenesisClawbot/bribeboard.git') {
  mkdirSync(join(target, '.git'), { recursive: true });
  writeFileSync(
    join(target, '.git', 'config'),
    `[remote "origin"]\n\turl = ${remote}\n`,
  );
}
