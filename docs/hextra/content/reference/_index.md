---
title: Reference
weight: 2
cascade:
  type: docs
---

What agentkit ships, stated exactly. Every table on these pages is generated from the repository
at build time, so a unit added, removed or rewired changes the page in the same commit — or the
build fails.

{{< cards >}}
{{< card link="/reference/skills/" title="Skill catalogue" subtitle="Every skill, the kit it belongs to, and what it is for. Built from each skill's own frontmatter." >}}
{{< card link="/reference/hooks/" title="Hooks" subtitle="Each police unit, the mechanism it runs on, what it refuses and the override it names." >}}
{{< card link="/reference/cli/" title="CLI and tools" subtitle="The executables that ship in `tools/`, including the two the installer omits off Linux." >}}
{{< card link="/reference/configuration/" title="Configuration" subtitle="Every key in `~/.config/agentkit/config.yaml`, its default, and what turning it on changes." >}}
{{< card link="/reference/environment/" title="Environment variables" subtitle="Every variable agentkit reads, grouped by what it is for — overrides first." >}}
{{< card link="/reference/glossary/" title="Glossary" subtitle="Definitions as the code means them, not as the words are used generally." >}}
{{< card link="/reference/faq/" title="FAQ" subtitle="The questions that come up once the enforcement is live." >}}
{{< /cards >}}
