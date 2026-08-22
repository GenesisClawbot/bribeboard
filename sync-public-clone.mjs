import {
  copyFileSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
} from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const OPTIONAL_PRODUCT_FILES = ['stripe-cutover.json'];

const PRODUCT_FILES = [
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
];

export function syncPublicClone({ sourceDir, targetDir }) {
  const source = resolve(sourceDir);
  const target = resolve(targetDir);
  const sourceReal = realpathSync(source);
  const targetReal = realpathSync(target);
  if (containsPath(targetReal, sourceReal) || containsPath(sourceReal, targetReal)) {
    throw new Error('target overlaps the source tree');
  }
  const gitConfig = join(targetReal, '.git', 'config');
  if (!existsSync(gitConfig)) {
    throw new Error('target is not a git clone');
  }
  const remote = originRemote(readFileSync(gitConfig, 'utf8'));
  if (![
    'https://github.com/GenesisClawbot/bribeboard.git',
    'git@github.com:GenesisClawbot/bribeboard.git',
  ].includes(remote)) {
    throw new Error('target is not the Bribeboard clone');
  }
  assertNoOwnedSymlinks(targetReal);

  const moderation = join(targetReal, 'moderation.json');
  validateEmptyBook(moderation, 'moderation book');
  const verdicts = join(targetReal, 'verdicts.json');
  validateEmptyBook(verdicts, 'legacy verdict book');

  const sourceDocs = join(sourceReal, 'docs');
  const required = [
    ...PRODUCT_FILES.map((file) => join(sourceReal, file)),
    join(sourceDocs, 'index.html'),
    join(sourceDocs, 'data.json'),
    join(sourceDocs, 'filings'),
  ];
  const missing = required.filter((path) => !existsSync(path));
  if (missing.length) {
    throw new Error(`source is incomplete: ${missing.join(', ')}`);
  }

  const stageRoot = mkdtempSync(join(targetReal, '.bribeboard-sync-'));
  const stagedFilings = join(stageRoot, 'filings');
  const liveFilings = join(targetReal, 'docs', 'filings');
  const previousFilings = join(stageRoot, 'previous-filings');
  const removedFiles = [];
  let copiedOptional = 0;
  try {
    cpSync(join(sourceDocs, 'filings'), stagedFilings, { recursive: true });
    for (const file of PRODUCT_FILES) {
      copyFileSync(join(sourceReal, file), join(targetReal, file));
    }
    for (const file of OPTIONAL_PRODUCT_FILES) {
      const sourceFile = join(sourceReal, file);
      const targetFile = join(targetReal, file);
      if (existsSync(sourceFile)) {
        copyFileSync(sourceFile, targetFile);
        copiedOptional += 1;
      } else if (existsSync(targetFile)) {
        rmSync(targetFile);
        removedFiles.push(file);
      }
    }
    mkdirSync(join(targetReal, 'docs'), { recursive: true });
    copyFileSync(join(sourceDocs, 'index.html'), join(targetReal, 'docs', 'index.html'));
    copyFileSync(join(sourceDocs, 'data.json'), join(targetReal, 'docs', 'data.json'));

    if (existsSync(liveFilings)) renameSync(liveFilings, previousFilings);
    try {
      renameSync(stagedFilings, liveFilings);
    } catch (error) {
      if (existsSync(previousFilings)) renameSync(previousFilings, liveFilings);
      throw error;
    }
    rmSync(previousFilings, { recursive: true, force: true });

    for (const [path, name] of [
      [moderation, 'moderation.json'],
      [verdicts, 'verdicts.json'],
    ]) {
      if (existsSync(path)) {
        rmSync(path);
        removedFiles.push(name);
      }
    }
  } finally {
    rmSync(stageRoot, { recursive: true, force: true });
  }

  return {
    copied_files: PRODUCT_FILES.length + copiedOptional + countFiles(sourceDocs),
    removed_files: removedFiles,
  };
}

function originRemote(config) {
  let inOrigin = false;
  const urls = [];
  for (const line of config.split(/\r?\n/)) {
    const section = line.match(/^\s*\[remote\s+"([^"]+)"\]\s*$/i);
    if (section) {
      inOrigin = section[1] === 'origin';
      continue;
    }
    if (/^\s*\[/.test(line)) {
      inOrigin = false;
      continue;
    }
    if (inOrigin) {
      const url = line.match(/^\s*url\s*=\s*(\S+)\s*$/i)?.[1];
      if (url) urls.push(url);
    }
  }
  return urls.length === 1 ? urls[0] : null;
}

function assertNoOwnedSymlinks(target) {
  for (const path of [
    ...PRODUCT_FILES.map((file) => join(target, file)),
    ...OPTIONAL_PRODUCT_FILES.map((file) => join(target, file)),
    join(target, 'docs'),
    join(target, 'docs', 'index.html'),
    join(target, 'docs', 'data.json'),
    join(target, 'docs', 'filings'),
    join(target, 'moderation.json'),
    join(target, 'verdicts.json'),
  ]) {
    if (ownedPathIsSymlink(path)) {
      throw new Error(`owned path is a symlink: ${path}`);
    }
  }
}

function ownedPathIsSymlink(path) {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

function containsPath(parent, child) {
  const path = relative(parent, child);
  return path === ''
    || (!isAbsolute(path) && path !== '..' && !path.startsWith(`..${sep}`));
}

function validateEmptyBook(path, label) {
  if (!existsSync(path)) return;
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    throw new Error(`${label} is not empty`);
  }
  if (!parsed
    || Array.isArray(parsed)
    || typeof parsed !== 'object'
    || Object.keys(parsed).length !== 0) {
    throw new Error(`${label} is not empty`);
  }
}

function countFiles(dir) {
  let count = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    count += entry.isDirectory() ? countFiles(path) : 1;
  }
  return count;
}

const currentFile = fileURLToPath(import.meta.url);
const isMain = process.argv[1]
  && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;

if (isMain) {
  const receipt = syncPublicClone({
    sourceDir: dirname(currentFile),
    targetDir: process.argv[2] || '/private/tmp/bribeboard-repo',
  });
  process.stdout.write(`${JSON.stringify(receipt, null, 2)}\n`);
}
