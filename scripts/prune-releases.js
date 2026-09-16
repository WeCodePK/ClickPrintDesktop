// Decides which GitHub releases are dead weight, so the tag list doesn't grow
// without bound now that every push to prod cuts one. Reads newline separated
// tags on stdin (as produced by `gh api .../releases`) and prints, one per
// line, every tag that should be deleted.
//
//   node scripts/prune-releases.js [keep]
//
// The `keep` newest versions survive, so the release the updater actually
// points at is never a candidate. Only plain X.Y.Z tags are ever printed:
// prereleases and hand-made tags are left alone rather than guessed at, which
// matches what next-version.js considers a release.

const keep = Number(process.argv[2] || 5);

const SEMVER = /^v?(\d+)\.(\d+)\.(\d+)$/;

function parse(tag) {
  const trimmed = tag.trim();
  const match = SEMVER.exec(trimmed);
  return match ? { tag: trimmed, version: match.slice(1, 4).map(Number) } : null;
}

// Newest first, so the survivors are simply the first `keep` entries.
function descending(a, b) {
  return b.version[0] - a.version[0] || b.version[1] - a.version[1] || b.version[2] - a.version[2];
}

let stdin = '';
process.stdin.on('data', (chunk) => (stdin += chunk));
process.stdin.on('end', () => {
  if (!Number.isInteger(keep) || keep < 1) {
    console.error(`Invalid keep count: ${process.argv[2]}`);
    process.exit(1);
  }

  const releases = stdin.split('\n').map(parse).filter(Boolean).sort(descending);

  for (const { tag } of releases.slice(keep)) {
    console.log(tag);
  }
});
