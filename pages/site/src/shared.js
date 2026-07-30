// Tokens resolve through color-scheme via light-dark(), so the toggle only
// pins data-theme. The head script already applied any stored choice before
// first paint; here the effective theme lands in the DOM so the icon state is
// real, and the system preference keeps driving it until a choice is made.
(() => {
  const btn = document.querySelector(".theme-btn");
  if (!btn) return;
  const root = document.documentElement;
  const sys = matchMedia("(prefers-color-scheme: light)");
  let chosen = null;
  try { chosen = localStorage.getItem("agentkit-theme"); } catch (e) {}
  if (chosen !== "light" && chosen !== "dark") chosen = null;
  const apply = (t) => {
    root.dataset.theme = t;
    const label = "Switch to " + (t === "dark" ? "light" : "dark") + " theme";
    btn.setAttribute("aria-label", label);
    btn.title = label;
  };
  apply(chosen ?? (sys.matches ? "light" : "dark"));
  sys.addEventListener("change", (e) => {
    if (!chosen) apply(e.matches ? "light" : "dark");
  });
  btn.hidden = false;
  btn.addEventListener("click", () => {
    chosen = root.dataset.theme === "dark" ? "light" : "dark";
    try { localStorage.setItem("agentkit-theme", chosen); } catch (e) {}
    apply(chosen);
  });
})();

// Flags scrollers that actually overflow so the fade affordance in theme.css
// only appears where there is something to scroll to.
(() => {
  const scrollers = [...document.querySelectorAll(".code, .scroll")];
  if (!scrollers.length) return;
  const sync = () => {
    for (const el of scrollers) {
      if (el.scrollWidth > el.clientWidth + 1) el.setAttribute("data-overflow", "1");
      else el.removeAttribute("data-overflow");
    }
  };
  sync();
  addEventListener("resize", sync);
})();

// Runs on every page; no-ops on pages without a .doc-body.
(() => {
  const body = document.querySelector(".doc-body");
  if (!body) return;

  const heads = [...body.querySelectorAll("h2[id], h3[id]")];
  // A heading that forgot its id would otherwise leave a labelled but empty
  // rail, which looks broken rather than telling anyone why.
  if (!heads.length) {
    document.querySelector(".toc")?.remove();
    return;
  }

  // Read the titles before anything is injected: an element inside the heading
  // would otherwise land in both its textContent and its accessible name.
  const titles = heads.map((h) => h.textContent.trim());

  // The permalink is decorative. Given an accessible name it would be pulled
  // into the heading's own name, so every heading would announce twice and
  // heading-list navigation would show doubled entries.
  heads.forEach((h) => {
    const a = document.createElement("a");
    a.className = "anchor";
    a.href = "#" + h.id;
    a.textContent = "#";
    a.setAttribute("aria-hidden", "true");
    a.tabIndex = -1;
    h.prepend(a);
  });

  const toc = document.querySelector("[data-toc]");
  if (!toc) return;

  // Below 64rem the rail becomes a block above the prose and starts closed, so
  // the label becomes the control that opens it. Only there: where the list is
  // always visible, a collapse control would report a state that is not real.
  const panel = toc.closest(".toc");
  const lbl = panel?.querySelector(".toc-lbl");
  if (panel && lbl) {
    const text = lbl.textContent;
    toc.id ||= "toc-list";
    const narrow = matchMedia("(max-width: 64rem)");
    const apply = () => {
      if (narrow.matches === !!lbl.querySelector(".toc-toggle")) return;
      if (!narrow.matches) {
        lbl.textContent = text;
        panel.removeAttribute("data-collapsed");
        return;
      }
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "toc-toggle";
      btn.textContent = text;
      btn.setAttribute("aria-controls", toc.id);
      btn.setAttribute("aria-expanded", "false");
      btn.addEventListener("click", () => {
        const opening = panel.hasAttribute("data-collapsed");
        panel.toggleAttribute("data-collapsed", !opening);
        btn.setAttribute("aria-expanded", String(opening));
      });
      lbl.replaceChildren(btn);
      panel.setAttribute("data-collapsed", "");
    };
    narrow.addEventListener("change", apply);
    apply();
  }

  const links = heads.map((h, i) => {
    const a = document.createElement("a");
    a.href = "#" + h.id;
    a.textContent = titles[i];
    if (h.tagName === "H3") a.className = "sub";
    toc.appendChild(a);
    return a;
  });

  let current = null;
  const mark = (i) => {
    if (current === links[i]) return;
    if (current) current.removeAttribute("aria-current");
    current = links[i];
    current.setAttribute("aria-current", "true");
  };

  // The last heading to cross the top of the reading area, not whichever is
  // merely visible: with short sections several are on screen at once and
  // "visible" flickers between them. Geometry is read live because an observer
  // entry carries the rect from when it fired, and a jump that settles where no
  // heading crosses the threshold fires no entry at all.
  let queued = false;
  const sync = () => {
    queued = false;
    let best = 0;
    for (let i = 0; i < heads.length; i++) {
      if (heads[i].getBoundingClientRect().top < 140) best = i;
    }
    // A final section shorter than the threshold can never scroll its own
    // heading past it, so the rail would stop one short at the very bottom.
    const atBottom = innerHeight + scrollY >= document.documentElement.scrollHeight - 2;
    mark(atBottom ? heads.length - 1 : best);
  };
  const schedule = () => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(sync);
  };
  addEventListener("scroll", schedule, { passive: true });
  addEventListener("resize", schedule);
  sync();
})();
