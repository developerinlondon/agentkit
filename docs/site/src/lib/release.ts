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

export interface ArchivedVersion {
	slug: string;
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
	archived: readonly ArchivedVersion[],
): VersionOption[] {
	return [
		{ label: release ? `${release} (latest)` : "latest", path: "/docs/" },
		...archived.map(({ slug, label }) => ({ label, path: `/docs/${slug}/` })),
	];
}
