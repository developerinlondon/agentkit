// Progressive enhancement for build-time diagrams. Without this file every
// figure is complete; with it a node highlights its connections on hover, tap
// or focus, and the figure can be enlarged to 1:1 in a modal view.
const PARTS = ".dg-node, .dg-group";

function highlight(svg, host) {
  const parts = [...svg.querySelectorAll(PARTS)];
  const edges = [...svg.querySelectorAll(".dg-edge")];
  if (!parts.length) return;
  svg.classList.add("dg-live");
  const tip = document.createElement("div");
  tip.className = "dg-tip";
  tip.hidden = true;
  tip.setAttribute("aria-live", "polite");
  host.appendChild(tip);
  let current = null;

  const clear = () => {
    current = null;
    svg.classList.remove("is-focusing");
    for (const el of [...parts, ...edges]) el.classList.remove("is-hot");
    tip.hidden = true;
  };

  const show = (el) => {
    if (current === el) return;
    clear();
    current = el;
    const id = el.dataset.id;
    const near = new Set([id]);
    for (const e of edges) {
      if (e.dataset.from === id || e.dataset.to === id) {
        e.classList.add("is-hot");
        near.add(e.dataset.from);
        near.add(e.dataset.to);
      }
    }
    for (const p of parts) if (near.has(p.dataset.id)) p.classList.add("is-hot");
    svg.classList.add("is-focusing");
    if (!el.dataset.desc) return;
    tip.textContent = el.dataset.desc;
    tip.hidden = false;
    const h = host.getBoundingClientRect();
    const r = el.getBoundingClientRect();
    const left = Math.max(8, Math.min(r.left - h.left + host.scrollLeft, host.scrollWidth - tip.offsetWidth - 8));
    const below = r.bottom - h.top + host.scrollTop + 8;
    const fits = below + tip.offsetHeight <= host.scrollHeight;
    tip.style.left = `${left}px`;
    tip.style.top = `${Math.max(4, fits ? below : r.top - h.top + host.scrollTop - tip.offsetHeight - 8)}px`;
  };

  for (const el of parts) {
    // The custom tip replaces the native one; two tooltips would stack.
    if (el.dataset.desc) el.querySelector(":scope > title")?.remove();
    if (el.classList.contains("dg-node")) {
      el.setAttribute("tabindex", "0");
      el.addEventListener("focus", () => show(el));
      el.addEventListener("blur", clear);
    }
    el.addEventListener("pointerenter", (ev) => ev.pointerType === "mouse" && show(el));
    el.addEventListener("pointerleave", (ev) => ev.pointerType === "mouse" && clear());
    el.addEventListener("click", (ev) => {
      ev.stopPropagation();
      if (current === el) clear();
      else show(el);
    });
  }
  host.addEventListener("keydown", (ev) => ev.key === "Escape" && current && (ev.stopPropagation(), clear()));
  return clear;
}

// Ids are rewritten, with every url(#…) and #… reference to them, so the copy's markers,
// gradients and title do not collide with the figure still on the page.
function cloneForZoom(svg) {
  const copy = svg.cloneNode(true);
  copy.classList.remove("dg-live", "is-focusing");
  for (const el of copy.querySelectorAll(".is-hot")) el.classList.remove("is-hot");
  for (const el of copy.querySelectorAll("[tabindex]")) el.removeAttribute("tabindex");
  const renamed = new Set();
  for (const el of copy.querySelectorAll("[id]")) {
    renamed.add(el.id);
    el.id += "-z";
  }
  const relink = (v) =>
    v
      .replace(/url\(#([^)]+)\)/g, (m, id) => (renamed.has(id) ? `url(#${id}-z)` : m))
      .replace(/^#(.+)$/, (m, id) => (renamed.has(id) ? `#${id}-z` : m));
  for (const el of copy.querySelectorAll("*")) {
    for (const a of [...el.attributes]) if (a.value.includes("#")) el.setAttribute(a.name, relink(a.value));
  }
  const labelled = copy.getAttribute("aria-labelledby");
  if (labelled) copy.setAttribute("aria-labelledby", labelled.replace(/(\S+)/g, "$1-z"));
  copy.style.width = `${svg.viewBox.baseVal.width}px`;
  return copy;
}

function zoom(fig, opener) {
  const svg = fig.querySelector(".dg-svg");
  const dlg = document.createElement("dialog");
  dlg.className = "dg-zoom";
  dlg.setAttribute("aria-label", `Enlarged diagram: ${svg.querySelector("title")?.textContent ?? ""}`);
  const bar = document.createElement("div");
  bar.className = "dg-zoom-bar";
  const hint = document.createElement("span");
  hint.className = "dg-zoom-hint";
  const close = document.createElement("button");
  close.type = "button";
  close.className = "dg-zoom-close";
  close.textContent = "Close";
  bar.append(hint, close);
  const pane = document.createElement("div");
  pane.className = "dg-zoom-pane";
  pane.append(cloneForZoom(svg));
  dlg.append(bar, pane);
  document.body.append(dlg);
  highlight(pane.firstChild, pane);
  close.addEventListener("click", () => dlg.close());
  dlg.addEventListener("click", (ev) => {
    if (ev.target === dlg || ev.target === pane) dlg.close();
  });
  dlg.addEventListener("close", () => {
    dlg.remove();
    opener.focus();
  });
  dlg.showModal();
  close.focus();
  if (pane.scrollWidth > pane.clientWidth || pane.scrollHeight > pane.clientHeight) {
    hint.textContent = "Scroll or drag to see the rest";
  }
}

function enhance(fig) {
  const svg = fig.querySelector(".dg-svg");
  if (!svg) return;
  highlight(svg, fig);
  const open = document.createElement("button");
  open.type = "button";
  open.className = "dg-enlarge";
  open.setAttribute("aria-label", "Enlarge diagram");
  open.innerHTML =
    '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2 6V2h4M14 6V2h-4M2 10v4h4M14 10v4h-4"/></svg><span>Enlarge</span>';
  fig.prepend(open);
  open.addEventListener("click", () => zoom(fig, open));
  // Parts stop their clicks, so only the canvas reaches this: tap-to-enlarge on phones.
  svg.addEventListener("click", () => zoom(fig, open));
}

for (const fig of document.querySelectorAll("figure.dg")) enhance(fig);
