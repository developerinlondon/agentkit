import starlight from "@astrojs/starlight";
import { defineConfig } from "astro/config";
import { currentVersionLabel, environmentSources } from "./src/lib/release";
import mermaid from "astro-mermaid";
import starlightLinksValidator from "starlight-links-validator";

const versionLabel = currentVersionLabel(environmentSources());

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
			routeMiddleware: "./src/starlightRouteData.ts",
			// The version select rides the theme select's slot in the header, which
			// is the one place a component override can reach the nav bar.
			components: { ThemeSelect: "./src/components/ThemeSelect.astro" },
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
			],
		}),
	],
});
