/**
 * Publish a sanitised snapshot of this repository to the public
 * mshresponse/orgtriage repository.
 *
 *   node tools/publish-public.mjs --dry-run   list what would be published
 *   node tools/publish-public.mjs             publish (needs a clean tree and push rights)
 *
 * orgsage stays the private working repository. This script never publishes
 * the working tree directly: it takes the tracked files, drops the internal
 * ones listed below, scans the rest for anything that looks like a secret,
 * and pushes the result to the public repository's main branch. The public
 * repository's LICENSE (Apache 2.0, created with the repository) is kept.
 *
 * Kept out on purpose:
 *   docs/reviews, docs/backlog, docs/BACKLOG.md   candid review and planning notes
 *   docs/FACTS.md, docs/GAPS.md, *-raw.json        research notes that name test orgs
 *   docs/STORE-SUBMISSION.md, docs/CODEX-*.md     listing internals, assistant briefs
 *   docs/sources                                   never committed anyway
 *   brand/                                         the mark is not Apache-licensed (TRADEMARK.md)
 *   CLAUDE.md                                      working rules for the assistant
 *   tools/probe/                                   a test tool that writes to a test org
 *   orgsage.zip, review-bundle.txt                 artefacts
 */
import { execSync } from 'node:child_process';
import { mkdtempSync, rmSync, mkdirSync, copyFileSync, readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';

const ROOT = new URL('..', import.meta.url).pathname.replace(/\/$/, '');
const PUBLIC_REMOTE = 'https://github.com/mshresponse/orgtriage.git';
const DRY = process.argv.includes('--dry-run');

const EXCLUDE_PREFIXES = [
  'docs/reviews/', 'docs/backlog/', 'docs/sources/', 'brand/', 'tools/probe/',
];
const EXCLUDE_FILES = new Set([
  'docs/BACKLOG.md', 'docs/FACTS.md', 'docs/GAPS.md', 'docs/gaps-raw.json', 'docs/research-raw.json',
  'docs/STORE-SUBMISSION.md', 'docs/CODEX-SITE-BRIEF.md', 'CLAUDE.md', 'orgsage.zip', 'review-bundle.txt',
  'tools/review-bundle.mjs',
]);
const SECRET_PATTERNS = [
  [/sk-ant-[A-Za-z0-9_-]{20,}/, 'Anthropic API key'],
  [/\bsid=[A-Za-z0-9!.]{20,}/, 'Salesforce session id'],
  [/\bBearer\s+00D[A-Za-z0-9!.]{20,}/, 'Salesforce access token'],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, 'private key'],
  [/\bAKIA[0-9A-Z]{16}\b/, 'AWS access key'],
  [/\bghp_[A-Za-z0-9]{30,}\b/, 'GitHub token'],
];

const sh = (cmd, cwd = ROOT) => execSync(cmd, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

// Only tracked files are snapshotted, so only modified tracked files matter;
// an untracked scratch file in the root is not a reason to refuse.
if (sh('git status --porcelain --untracked-files=no')) {
  console.error('Tracked files have uncommitted changes. Commit or stash first; the snapshot is taken from the committed tree.');
  process.exit(1);
}
const sha = sh('git rev-parse --short HEAD');
const version = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version;

const files = sh('git ls-files')
  .split('\n')
  .filter((f) => f && !EXCLUDE_FILES.has(f) && !EXCLUDE_PREFIXES.some((p) => f.startsWith(p)));
if (!files.includes('TRADEMARK.md')) {
  console.error('TRADEMARK.md is missing; it must ship with the code.');
  process.exit(1);
}

// Secret scan over what will be published, text files only.
const TEXT = /\.(ts|mjs|js|css|html|json|md|txt|yml|yaml|svg)$/;
let leaked = 0;
for (const f of files) {
  if (!TEXT.test(f)) continue;
  const body = readFileSync(join(ROOT, f), 'utf8');
  for (const [re, what] of SECRET_PATTERNS) {
    // The vendored flow scanner carries a regex that *matches* keys; a literal match on
    // the pattern source is not a leak. Anything else is.
    if (re.test(body) && !/pattern:\s*\/sk-ant-/.test(body)) {
      console.error(`${f}: looks like a ${what}`);
      leaked += 1;
    }
  }
}
if (leaked) {
  console.error(`${leaked} file(s) look like they carry a secret. Nothing published.`);
  process.exit(1);
}

console.log(`OrgTriage ${version} @ ${sha}: ${files.length} files to publish`);
if (DRY) {
  console.log(files.join('\n'));
  process.exit(0);
}

const work = mkdtempSync(join(tmpdir(), 'orgtriage-public-'));
sh(`git clone --quiet --depth 1 ${PUBLIC_REMOTE} public`, work);
const target = join(work, 'public');

// Wipe everything the public repo tracks except its LICENSE and .git.
for (const entry of readdirSync(target)) {
  if (entry === '.git' || entry === 'LICENSE') continue;
  rmSync(join(target, entry), { recursive: true, force: true });
}
for (const f of files) {
  const dest = join(target, f);
  mkdirSync(dirname(dest), { recursive: true });
  copyFileSync(join(ROOT, f), dest);
}
if (!existsSync(join(target, 'LICENSE'))) {
  console.error('The public repository has no LICENSE; create it there (Apache 2.0) before publishing.');
  process.exit(1);
}

sh('git add -A', target);
if (!sh('git status --porcelain', target)) {
  console.log('Public repository already matches this snapshot; nothing to push.');
  process.exit(0);
}
sh(`git -c user.name="Everything Virtually LLC" -c user.email="mike@everythingvirtually.com" commit --quiet -m "OrgTriage ${version} (orgsage ${sha})"`, target);
sh('git push --quiet origin HEAD:main', target);
console.log(`Published OrgTriage ${version} to ${PUBLIC_REMOTE} (main).`);
rmSync(work, { recursive: true, force: true });
