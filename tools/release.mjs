// Cut a release: the git tag is the version, and src/version.js mirrors it so
// the page can show it (GitHub Pages serves files, not git metadata).
//
//   node tools/release.mjs patch "Commit message"   v0.1.0 -> v0.1.1
//   node tools/release.mjs minor "Commit message"   v0.1.3 -> v0.2.0
//   node tools/release.mjs major "Commit message"   v0.4.2 -> v1.0.0
//   node tools/release.mjs v2.0.0 "Commit message"  explicit version
//
// Stages all changes, writes src/version.js, commits, and tags the commit.
// Push with: git push --follow-tags
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

const [bump = 'patch', message] = process.argv.slice(2);
if (!message) {
  console.error('Usage: node tools/release.mjs <patch|minor|major|vX.Y.Z> "Commit message"');
  process.exit(1);
}

let last = 'v0.0.0';
try { last = git('describe', '--tags', '--abbrev=0', '--match', 'v[0-9]*'); } catch { /* no tags yet */ }
const [maj, min, pat] = last.replace(/^v/, '').split('.').map(Number);
const next = /^v?\d+\.\d+\.\d+$/.test(bump) ? `v${bump.replace(/^v/, '')}`
  : bump === 'major' ? `v${maj + 1}.0.0`
  : bump === 'minor' ? `v${maj}.${min + 1}.0`
  : `v${maj}.${min}.${pat + 1}`;
if (git('tag', '--list', next)) { console.error(`Tag ${next} already exists.`); process.exit(1); }

writeFileSync(join(root, 'src/version.js'),
  `// Written by tools/release.mjs. The git tag ${next} is the source of truth.\nexport const VERSION = '${next}';\n`);
git('add', '-A');
git('commit', '-q', '-m', message);
git('tag', '-a', next, '-m', next);
console.log(`${last} -> ${next} (${git('rev-parse', '--short', 'HEAD')})`);
