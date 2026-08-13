export interface Version {
  major: number;
  minor: number;
  patch: number;
  // Dot-separated identifiers, empty for a release. A release outranks every
  // prerelease of the same core, which is what makes rc1 -> rc2 -> final an
  // ascending sequence rather than three unrelated tags.
  prerelease: string[];
}

// A leading `v` is the tag convention rather than the grammar, and build
// metadata is ignored for precedence — both per semver itself.
const SEMVER =
  /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

export function parseVersion(tag: string): Version | undefined {
  const parts = SEMVER.exec(tag.trim());
  if (parts === null) return undefined;
  const prerelease = parts[4];
  return {
    major: Number(parts[1]),
    minor: Number(parts[2]),
    patch: Number(parts[3]),
    prerelease: prerelease === undefined ? [] : prerelease.split('.'),
  };
}

function compareIdentifiers(left: string, right: string): number {
  const leftNumeric = /^\d+$/.test(left);
  const rightNumeric = /^\d+$/.test(right);
  if (leftNumeric && rightNumeric) return Number(left) - Number(right);
  if (leftNumeric) return -1;
  if (rightNumeric) return 1;
  return left < right ? -1 : left > right ? 1 : 0;
}

function comparePrerelease(left: string[], right: string[]): number {
  if (left.length === 0 && right.length === 0) return 0;
  if (left.length === 0) return 1;
  if (right.length === 0) return -1;
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const one = left[index];
    const other = right[index];
    if (one === undefined) return -1;
    if (other === undefined) return 1;
    const order = compareIdentifiers(one, other);
    if (order !== 0) return order;
  }
  return 0;
}

export function compareVersions(left: Version, right: Version): number {
  if (left.major !== right.major) return left.major - right.major;
  if (left.minor !== right.minor) return left.minor - right.minor;
  if (left.patch !== right.patch) return left.patch - right.patch;
  return comparePrerelease(left.prerelease, right.prerelease);
}

// The major.minor a tag belongs to. A release line is what makes a lower tag
// maintenance rather than a mistake.
export function sameLine(left: Version, right: Version): boolean {
  return left.major === right.major && left.minor === right.minor;
}

export function sameCore(left: Version, right: Version): boolean {
  return sameLine(left, right) && left.patch === right.patch;
}
