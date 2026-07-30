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
// release; archives carry their own sidebar entries rather than sharing a
// select that would need disambiguating.
export function currentVersionLabel(sources: ReleaseSources): string {
	return currentRelease(sources) || "latest";
}
