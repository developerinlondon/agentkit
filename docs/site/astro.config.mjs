import starlight from "@astrojs/starlight";
import { defineConfig } from "astro/config";
import mermaid from "astro-mermaid";
import starlightVersions from "starlight-versions";
import starlightLinksValidator from "starlight-links-validator";

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
			// The unversioned root documents `main`, which is what the curl-pipe
			// installer actually gives you. Archived versions are frozen copies cut
			// at a release, committed to the repository by the plugin on the next
			// build after a version is declared here.
			plugins: [
				// Starlight does not check internal links itself, so before this a
				// renamed page left dangling links that shipped silently.
				starlightVersions({ versions: [{ slug: "0.4", label: "v0.4" }] }),
				starlightLinksValidator({ errorOnRelativeLinks: false }),
			],
			sidebar: [
				{ label: "Introduction", link: "/" },
				{
					label: "Getting started",
					items: [{ autogenerate: { directory: "getting-started" } }],
				},
				{ label: "Thinking in agentkit", link: "/thinking/" },
				{ label: "Concepts", items: [{ autogenerate: { directory: "concepts" } }] },
				{ label: "Reference", items: [{ autogenerate: { directory: "reference" } }] },
				{ label: "Cookbook", items: [{ autogenerate: { directory: "cookbook" } }] },
				{ label: "Community", items: [{ autogenerate: { directory: "community" } }] },
			],
		}),
	],
});
