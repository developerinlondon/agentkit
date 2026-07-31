import type { APIRoute } from "astro";
import { archivedReleases, currentRelease, environmentSources, versionOptions } from "../lib/release";

// The switching chrome injected into archived builds reads this. It has to come
// from the current build rather than from each archive's own tag: a release
// cannot know which versions followed it.
export const GET: APIRoute = () => {
	const release = currentRelease(environmentSources());
	return new Response(
		JSON.stringify({ current: release, versions: versionOptions(release, archivedReleases()) }),
		{ headers: { "content-type": "application/json" } },
	);
};
