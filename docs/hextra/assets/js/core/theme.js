// Single-click light/dark toggle, replacing Hextra's three-option menu.
//
// `setTheme` is defined in the theme's head script, which has already applied
// the stored choice before first paint; this only reflects that state on the
// button and flips it on click.
(function () {
  const buttons = document.querySelectorAll(".ak-theme-toggle");
  if (buttons.length === 0) return;

  const current = () => (document.documentElement.classList.contains("dark") ? "dark" : "light");

  function paint() {
    const theme = current();
    const next = theme === "dark" ? "light" : "dark";
    buttons.forEach((button) => {
      button.dataset.theme = theme;
      button.setAttribute("aria-label", `Switch to the ${next} theme`);
      button.setAttribute("title", `Switch to the ${next} theme`);
    });
  }

  paint();

  buttons.forEach((button) => {
    button.addEventListener("click", function (event) {
      event.preventDefault();
      const next = current() === "dark" ? "light" : "dark";
      setTheme(next);
      localStorage.setItem("color-theme", next);
      paint();
    });
  });

  // Only while the reader has expressed no preference of their own.
  window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", function () {
    if (!("color-theme" in localStorage) || localStorage.getItem("color-theme") === "system") {
      setTheme("system");
      paint();
    }
  });
})();

// Version picker: an archived version is a separate published tree, so the
// only thing to do is navigate to it.
(function () {
  document.querySelectorAll(".ak-version-picker").forEach(function (picker) {
    picker.addEventListener("change", function () {
      if (picker.value) window.location.href = picker.value;
    });
  });
})();
