import { execFileSync } from "node:child_process";
import starlight from "@astrojs/starlight";
import { defineConfig } from "astro/config";
import { currentVersionLabel } from "./src/lib/release";
import mermaid from "astro-mermaid";
import starlightLinksValidator from "starlight-links-validator";
import archivedVersions from "./archived-versions.json";

const versionLabel = currentVersionLabel({
	env: process.env.AGENTKIT_DOCS_VERSION,
	describe: () =>
		execFileSync("git", ["describe", "--tags", "--abbrev=0"], {
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
		}),
});

export default defineConfig({
	site: "https://agentkit.sbs",
	base: "/docs",
	trailingSlash: "always",
	integrations: [
		mermaid({ theme: "dark", autoTheme: true }),
		starlight({
			title: "agentkit",
			description: "Discipline for coding agents: hooks that refuse, skills that instruct.",
			customCss: ["./src/styles/agentkit.css"],
			pagefind: true,
			plugins: [
				// Starlight does not check internal links itself, so before this a
				// renamed page left dangling links that shipped silently.
				starlightLinksValidator({ errorOnRelativeLinks: false }),
			],
			sidebar: [
				{ label: `Introduction (${versionLabel})`, link: "/" },
				{
					label: "Getting started",
					items: [{ autogenerate: { directory: "getting-started" } }],
				},
				{ label: "Thinking in agentkit", link: "/thinking/" },
				{ label: "Concepts", items: [{ autogenerate: { directory: "concepts" } }] },
				{ label: "Reference", items: [{ autogenerate: { directory: "reference" } }] },
				{ label: "Cookbook", items: [{ autogenerate: { directory: "cookbook" } }] },
				{ label: "Community", items: [{ autogenerate: { directory: "community" } }] },
				// Archived versions are separate sites built from their own git tags
				// by build-archives.sh at publish time; nothing on main can alter or
				// break them, which is the whole point of building them from tags.
				{
					label: "Older versions",
					items: archivedVersions.map(({ slug, label }) => ({
						label,
						link: `/${slug}/`,
					})),
				},
			],
		}),
	],
});
