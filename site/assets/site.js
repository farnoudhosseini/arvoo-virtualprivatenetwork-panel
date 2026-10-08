/**
 * Bilingual public site (spec §32).
 *
 * Every translatable element carries its English and Persian text in
 * data-en / data-fa, so both languages are present in the served HTML without
 * a build step. The toggle swaps the text, the document direction, the lang
 * attribute and (for Persian) the font stack, then remembers the choice.
 *
 * Deliberate choices:
 *   * Persian is written as a proper RTL document (dir="rtl"), not as LTR text
 *     with reversed words;
 *   * no motion is used to switch language: this is a content change;
 *   * the URL gains ?lang=fa so a Persian page can be linked or shared;
 *   * nothing here depends on a third-party script, font CDN or analytics:
 *     the site loads no external resources at all.
 */
(function () {
  "use strict";

  var STORAGE_KEY = "arvoo.site.lang";

  function apply(lang) {
    var isFa = lang === "fa";
    document.documentElement.lang = isFa ? "fa" : "en";
    document.documentElement.dir = isFa ? "rtl" : "ltr";

    var nodes = document.querySelectorAll("[data-en][data-fa]");
    for (var i = 0; i < nodes.length; i++) {
      var node = nodes[i];
      var text = node.getAttribute(isFa ? "data-fa" : "data-en");
      if (text) node.textContent = text;
    }

    var button = document.getElementById("lang");
    if (button) {
      // The button shows the language you would switch *to*.
      button.setAttribute("aria-label", isFa ? "Switch to English" : "تغییر به فارسی");
    }

    var title = document.querySelector("title");
    if (title) {
      title.textContent = isFa
        ? "آروو — ابر، اتصال و زیرساخت مدیریت‌شده"
        : "Arvoo — cloud, connectivity and managed infrastructure";
    }
  }

  function initial() {
    var fromQuery = new URLSearchParams(window.location.search).get("lang");
    if (fromQuery === "fa" || fromQuery === "en") return fromQuery;
    try {
      var stored = window.localStorage.getItem(STORAGE_KEY);
      if (stored === "fa" || stored === "en") return stored;
    } catch (err) {
      /* private mode: fall through to the browser language */
    }
    return (navigator.language || "en").toLowerCase().indexOf("fa") === 0 ? "fa" : "en";
  }

  function set(lang) {
    apply(lang);
    try {
      window.localStorage.setItem(STORAGE_KEY, lang);
    } catch (err) {
      /* the choice simply is not remembered */
    }
    var url = new URL(window.location.href);
    url.searchParams.set("lang", lang);
    window.history.replaceState(null, "", url.toString());
  }

  var current = initial();
  apply(current);

  var button = document.getElementById("lang");
  if (button) {
    button.addEventListener("click", function () {
      current = current === "fa" ? "en" : "fa";
      set(current);
    });
  }
})();
