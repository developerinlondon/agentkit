import { execFileSync } from "node:child_process";

// "Latest" alone does not answer "latest what". The release is resolved at build
// time rather than committed to a generated file: the tag is created after the
// commit it points at, so a drift-checked file would disagree with the tree at tag
// time by construction.
export interface ReleaseSources {
	env?: string | undefined;
	describe?: () => string;
}

const RELEASE = /^v\d+\.\d+\.\d+$/;

export function currentRelease({ env, describe }: ReleaseSources): string {
	// CI passes the tag it is building, which needs no git and cannot be ambiguous.
	if (env && RELEASE.test(env.trim())) return env.trim();
	if (!describe) return "";
	try {
		const described = describe().trim();
		return RELEASE.test(described) ? described : "";
	} catch {
		return "";
	}
}

// Rendered inside the sidebar's own parentheses, so the label is the bare
// release; the version select composes its own label instead.
export function currentVersionLabel(sources: ReleaseSources): string {
	return currentRelease(sources) || "latest";
}

// The one seam both the config and the version select resolve the release
// through, so a build cannot label its sidebar and its picker differently.
export function environmentSources(): ReleaseSources {
	return {
		env: process.env.AGENTKIT_DOCS_VERSION,
		describe: () =>
			execFileSync("git", ["describe", "--tags", "--abbrev=0"], {
				encoding: "utf8",
				stdio: ["ignore", "pipe", "ignore"],
			}),
	};
}

export interface ArchivedRelease {
	slug: string;
	tag: string;
	label: string;
}

export interface VersionOption {
	label: string;
	path: string;
}

// Paths are absolute rather than base-relative: an archive is a separate site
// mounted at its own base, and the select has to leave it.
export function versionOptions(
	release: string,
	archived: readonly ArchivedRelease[],
): VersionOption[] {
	return [
		{ label: release ? `${release} (latest)` : "latest", path: "/docs/" },
		...archived.map(({ slug, label }) => ({ label, path: `/docs/${slug}/` })),
	];
}

export const ARCHIVE_LIMIT = 20;

// The tree that has to exist for a tag to build an archive at all. The docs site
// landed mid-0.4, so the older tags carry no site and handing one to the archive
// builder fails the deploy rather than skipping it.
const DOCS_ENTRY = "docs/site/astro.config.mjs";

function compareReleases(left: string, right: string): number {
	const [leftParts, rightParts] = [left, right].map((release) =>
		release.slice(1).split(".").map(Number)
	);
	for (let index = 0; index < 3; index++) {
		const difference = (leftParts[index] ?? 0) - (rightParts[index] ?? 0);
		if (difference !== 0) return difference;
	}
	return 0;
}

export function selectArchives(
	tags: readonly string[],
	release: string,
	limit = ARCHIVE_LIMIT,
): ArchivedRelease[] {
	const releases = [...new Set(tags.map((tag) => tag.trim()).filter((tag) => RELEASE.test(tag)))];
	releases.sort((left, right) => compareReleases(right, left));
	// At or above the release being built is not an archive of it: at tag time the
	// new tag exists, and the unversioned site is that release.
	const older = release
		? releases.filter((tag) => compareReleases(tag, release) < 0)
		: releases;
	return older
		.slice(0, Math.max(0, limit))
		.map((tag) => ({ slug: tag.slice(1), tag, label: tag }));
}

const git = (args: string[]): string =>
	execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });

function buildableTags(): string[] {
	try {
		return git(["tag", "--list", "v*"]).split("\n").filter((tag) => {
			try {
				git(["cat-file", "-e", `${tag.trim()}:${DOCS_ENTRY}`]);
				return true;
			} catch {
				return false;
			}
		});
	} catch {
		// No git, no archives — a shallow or exported tree still has to build.
		return [];
	}
}

export function archivedReleases(limit = ARCHIVE_LIMIT): ArchivedRelease[] {
	return selectArchives(buildableTags(), currentRelease(environmentSources()), limit);
}
