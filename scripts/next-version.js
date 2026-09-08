// Derives the next release version from the tags of existing GitHub releases,
// so package.json never has to carry a real version number. Reads newline
// separated tags on stdin (as produced by `gh api .../releases`).
//
//   node scripts/next-version.js [patch|minor|major] [baseline]
//
// The baseline is only used when the repo has no releases yet.

const bump = process.argv[2] || 'patch';
const baseline = process.argv[3] || '0.0.0';

const SEMVER = /^v?(\d+)\.(\d+)\.(\d+)$/;

function parse(tag) {
  const match = SEMVER.exec(tag.trim());
  return match ? match.slice(1, 4).map(Number) : null;
}

// Ignores prereleases and anything else that isn't a plain X.Y.Z tag.
function highest(tags) {
  return tags
    .map(parse)
    .filter(Boolean)
    .sort((a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2])
    .pop();
}

function increment([major, minor, patch]) {
  if (bump === 'major') return [major + 1, 0, 0];
  if (bump === 'minor') return [major, minor + 1, 0];
  return [major, minor, patch + 1];
}

let stdin = '';
process.stdin.on('data', (chunk) => (stdin += chunk));
process.stdin.on('end', () => {
  const current = highest(stdin.split('\n')) || parse(baseline);

  if (!current) {
    console.error(`Invalid baseline version: ${baseline}`);
    process.exit(1);
  }

  console.log(increment(current).join('.'));
});
