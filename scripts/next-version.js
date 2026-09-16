// Derives the next release version, so package.json never has to be bumped for
// an ordinary release. Two things feed into it:
//
//   * the highest existing GitHub release tag, patch-bumped — the default, so a
//     plain push to prod ships x.y.(z+1) without anyone editing a file
//   * the version declared in package.json, which acts as a floor — commit a
//     higher one (1.1.0, 2.0.0) and that is what ships instead
//
// The higher of the two wins. That is also what keeps the result collision
// free: the patch bump always sits above every existing release, so a declared
// version that has merely gone stale, or that matches a tag already handed out,
// can never be released a second time.
//
//   node scripts/next-version.js <declared-version> < tags.txt
//
// Reads newline separated tags on stdin (as produced by `gh api .../releases`).

const declaredArg = process.argv[2] || '0.0.0';

const SEMVER = /^v?(\d+)\.(\d+)\.(\d+)$/;

function parse(tag) {
  const match = SEMVER.exec(tag.trim());
  return match ? match.slice(1, 4).map(Number) : null;
}

function compare(a, b) {
  return a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
}

// Ignores prereleases and anything else that isn't a plain X.Y.Z tag.
function highest(tags) {
  return tags.map(parse).filter(Boolean).sort(compare).pop();
}

function nextPatch([major, minor, patch]) {
  return [major, minor, patch + 1];
}

let stdin = '';
process.stdin.on('data', (chunk) => (stdin += chunk));
process.stdin.on('end', () => {
  const declared = parse(declaredArg);

  if (!declared) {
    console.error(`Invalid version in package.json: ${declaredArg}`);
    process.exit(1);
  }

  const latest = highest(stdin.split('\n'));

  // With no releases yet there is nothing to bump past, so package.json is
  // taken at face value rather than incremented.
  const candidate = latest ? nextPatch(latest) : declared;

  console.log((compare(candidate, declared) >= 0 ? candidate : declared).join('.'));
});
