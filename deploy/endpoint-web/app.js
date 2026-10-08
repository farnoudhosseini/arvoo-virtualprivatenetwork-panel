/**
 * Arvoo public endpoint page.
 *
 * Two jobs, both small:
 *   1. Bilingual rendering (Persian RTL default, English LTR), including the
 *      bidi safety for IPs, ports and timestamps.
 *   2. Rendering the server's own status.json — honestly. Missing, stale or
 *      partial data is displayed as exactly that: never as a green state.
 *
 * No third-party code, no analytics, no requests other than ./status.json.
 */
(function () {
  "use strict";

  var html = document.documentElement;
  var FA_DIGITS = ["۰", "۱", "۲", "۳", "۴", "۵", "۶", "۷", "۸", "۹"];
  var STALE_AFTER_MS = 5 * 60 * 1000;

  function t(fa, en) {
    return html.lang === "fa" ? fa : en;
  }

  /** Persian numerals for Persian prose; identifiers keep Latin digits. */
  function digits(value) {
    var text = String(value);
    if (html.lang !== "fa") return text;
    return text.replace(/[0-9]/g, function (d) {
      return FA_DIGITS[Number(d)];
    });
  }

  function setLanguage(lang) {
    var chosen = lang === "en" ? "en" : "fa";
    html.lang = chosen;
    html.dir = chosen === "fa" ? "rtl" : "ltr";
    document.title =
      chosen === "fa" ? "آروو — زیرساخت شبکه و ترانزیت" : "Arvoo — network infrastructure and transit";

    document.querySelectorAll("[data-fa]").forEach(function (node) {
      var value = node.getAttribute("data-" + chosen);
      if (value !== null) node.textContent = value;
    });

    var button = document.getElementById("lang");
    if (button) {
      button.textContent = chosen === "fa" ? "EN" : "فا";
      button.setAttribute(
        "aria-label",
        chosen === "fa" ? "Switch to English" : "تغییر به فارسی",
      );
    }
    try {
      localStorage.setItem("arvoo-lang", chosen);
    } catch (err) {
      /* storage may be blocked; the switch still works for this page view */
    }
  }

  // ---- status board ------------------------------------------------------

  function row(label, detail, value, state) {
    var wrap = document.createElement("div");
    wrap.className = "row";

    var dot = document.createElement("span");
    dot.className = "dot " + (state || "unknown");
    dot.setAttribute("aria-hidden", "true");

    var name = document.createElement("span");
    name.className = "name";
    name.textContent = label;
    if (detail) {
      var small = document.createElement("small");
      small.textContent = detail;
      name.appendChild(small);
    }

    var val = document.createElement("span");
    val.className = "value";
    val.textContent = digits(value);
    if (html.lang === "fa") val.setAttribute("dir", "ltr");

    wrap.appendChild(dot);
    wrap.appendChild(name);
    wrap.appendChild(val);
    return wrap;
  }

  function setNote(message) {
    var note = document.getElementById("board-note");
    if (note) note.textContent = message;
  }

  function describeAge(generatedAt) {
    var ms = Date.now() - new Date(generatedAt).getTime();
    if (!isFinite(ms) || ms < 0) return { stale: true, text: t("زمان نامعتبر", "invalid timestamp") };
    var minutes = Math.floor(ms / 60000);
    var text =
      minutes < 1
        ? t("همین حالا", "just now")
        : minutes < 60
          ? t(minutes + " دقیقه پیش", minutes + " min ago")
          : t(Math.floor(minutes / 60) + " ساعت پیش", Math.floor(minutes / 60) + " h ago");
    return { stale: ms > STALE_AFTER_MS, text: text };
  }

  /**
   * Everything derived from status.json is cleared together. When the file
   * stops being readable, previously rendered numbers must not remain on
   * screen looking current — a stale green row is exactly the fake state this
   * page refuses to show.
   */
  function resetDerived() {
    ["fact-locations", "fact-tls", "fact-stamp"].forEach(function (id) {
      var node = document.getElementById(id);
      if (node) node.textContent = "—";
    });
    var tbody = document.getElementById("locations-body");
    if (tbody) {
      tbody.replaceChildren();
      var tr = document.createElement("tr");
      var td = document.createElement("td");
      td.colSpan = 4;
      td.className = "missing";
      td.textContent = t("داده‌ای در status.json نیست", "No node data in status.json");
      tr.appendChild(td);
      tbody.appendChild(tr);
    }
    var contact = document.getElementById("support-contact");
    if (contact) {
      contact.textContent = t("در status.json تعریف نشده", "Not defined in status.json");
      contact.classList.add("missing");
    }
    var docs = document.getElementById("support-docs");
    if (docs) {
      docs.textContent = t("در status.json تعریف نشده", "Not defined in status.json");
      docs.classList.add("missing");
    }
    var footer = document.getElementById("footer-stamp");
    if (footer) footer.textContent = "—";
  }

  function renderStatus(status, httpCode) {
    var body = document.getElementById("board-body");
    var stamp = document.getElementById("board-stamp");
    if (!body) return;
    body.replaceChildren();

    if (!status) {
      resetDerived();
      if (stamp) stamp.textContent = "status.json —";
      body.appendChild(
        row(
          t("وضعیت در دسترس نیست", "Status unavailable"),
          t("status.json خوانده نشد", "status.json could not be read"),
          httpCode ? "HTTP " + httpCode : "—",
          "unknown",
        ),
      );
      setNote(
        t(
          "این صفحه فقط چیزی را نشان می‌دهد که از سیستم خوانده باشد. تا وقتی status.json در دسترس نباشد، هیچ وضعیت سبزی نمایش داده نمی‌شود.",
          "This page only shows what it can read from the system. Until status.json is available, nothing is shown as healthy.",
        ),
      );
      return;
    }

    var age = describeAge(status.generatedAt);
    if (stamp) stamp.textContent = new Date(status.generatedAt).toISOString().replace("T", " ").slice(0, 16) + "Z";

    var listeners = Array.isArray(status.listeners) ? status.listeners : [];
    var certificates = Array.isArray(status.certificates) ? status.certificates : [];
    var web = status.web || null;

    if (listeners.length === 0) {
      body.appendChild(
        row(
          t("سرویس‌های شنودکننده", "Listening services"),
          t("در status.json فهرست نشده", "not listed in status.json"),
          "—",
          "unknown",
        ),
      );
    } else {
      listeners.forEach(function (entry) {
        var state = entry.status === "listening" ? "live" : entry.status === "down" ? "down" : "warn";
        var port = (entry.protocol || "tcp") + " " + (entry.port != null ? entry.port : "?");
        body.appendChild(row(entry.service || t("سرویس", "service"), port, entry.status || "unknown", state));
      });
    }

    if (certificates.length === 0) {
      body.appendChild(row(t("گواهی TLS", "TLS certificate"), t("گزارش نشده", "not reported"), "—", "unknown"));
    } else {
      certificates.forEach(function (cert) {
        var days = typeof cert.daysLeft === "number" ? cert.daysLeft : null;
        var state = days == null ? "unknown" : days < 7 ? "down" : days < 21 ? "warn" : "live";
        var value = days == null ? t("نامعلوم", "unknown") : t(days + " روز", days + " days");
        body.appendChild(row(cert.name || t("گواهی", "certificate"), cert.expiresAt || "", value, state));
      });
    }

    var webState = web && web.status === "ok" ? "live" : web ? "warn" : "unknown";
    body.appendChild(
      row(
        t("سرویس وب", "Web service"),
        t("همین صفحه", "this page"),
        web && web.status ? web.status : t("گزارش نشده", "not reported"),
        webState,
      ),
    );

    if (age.stale) {
      setNote(
        t(
          "آخرین گزارش " + age.text + " است و قدیمی‌تر از پنجره‌ی قابل‌اعتماد محسوب می‌شود؛ این صفحه آن را تازه فرض نمی‌کند.",
          "The newest report is " + age.text + ", which is older than the freshness window; this page does not treat it as current.",
        ),
      );
    } else {
      setNote(
        t(
          "همه‌ی مقادیر بالا از status.json همین سرور خوانده شده‌اند. اگر سرویسی گزارش نشده باشد، به‌جای وضعیت سبز «گزارش نشده» می‌بینید.",
          "Every value above comes from this server's status.json. A service that is not reported shows as \"not reported\" instead of a green state.",
        ),
      );
    }

    // Headline facts and the locations table come from the same file.
    var factLocations = document.getElementById("fact-locations");
    var nodes = Array.isArray(status.nodes) ? status.nodes : [];
    if (factLocations) {
      factLocations.textContent = nodes.length ? digits(nodes.length) : "—";
    }

    var factTls = document.getElementById("fact-tls");
    if (factTls) {
      factTls.textContent = certificates.length && typeof certificates[0].daysLeft === "number"
        ? digits(t(certificates[0].daysLeft + " روز", certificates[0].daysLeft + " days"))
        : "—";
    }

    var factStamp = document.getElementById("fact-stamp");
    if (factStamp) factStamp.textContent = age.text;

    var tbody = document.getElementById("locations-body");
    if (tbody) {
      tbody.replaceChildren();
      if (nodes.length === 0) {
        var tr = document.createElement("tr");
        var td = document.createElement("td");
        td.colSpan = 4;
        td.className = "missing";
        td.textContent = t("داده‌ای در status.json نیست", "No node data in status.json");
        tr.appendChild(td);
        tbody.appendChild(tr);
      } else {
        nodes.forEach(function (node) {
          var tr = document.createElement("tr");
          [node.name, node.location, node.role].forEach(function (value) {
            var td = document.createElement("td");
            td.className = "mono";
            td.textContent = value == null ? "—" : String(value);
            tr.appendChild(td);
          });
          var stateTd = document.createElement("td");
          stateTd.textContent = node.status == null ? t("گزارش نشده", "not reported") : String(node.status);
          if (node.status === "listening" || node.status === "online") stateTd.style.color = "var(--live)";
          tr.appendChild(stateTd);
          tbody.appendChild(tr);
        });
      }
    }

    var contact = document.getElementById("support-contact");
    if (contact) {
      if (status.contact) {
        contact.textContent = String(status.contact);
        contact.classList.remove("missing");
      } else {
        contact.textContent = t("در status.json تعریف نشده", "Not defined in status.json");
        contact.classList.add("missing");
      }
    }
    var docs = document.getElementById("support-docs");
    if (docs) {
      if (status.docs) {
        docs.textContent = String(status.docs);
        docs.classList.remove("missing");
      } else {
        docs.textContent = t("در status.json تعریف نشده", "Not defined in status.json");
        docs.classList.add("missing");
      }
    }

    var footer = document.getElementById("footer-stamp");
    if (footer) footer.textContent = "status " + new Date(status.generatedAt).toISOString();
  }

  // ---- boot --------------------------------------------------------------

  var stored = null;
  try {
    stored = localStorage.getItem("arvoo-lang");
  } catch (err) {
    stored = null;
  }
  var fromQuery = new URLSearchParams(location.search).get("lang");
  setLanguage(fromQuery || stored || "fa");

  document.getElementById("lang").addEventListener("click", function () {
    setLanguage(html.lang === "fa" ? "en" : "fa");
    // Re-render so numerals and notes follow the new language.
    load();
  });

  function load() {
    fetch("./status.json", { cache: "no-store" })
      .then(function (res) {
        if (!res.ok) return renderStatus(null, res.status);
        return res.json().then(function (data) {
          renderStatus(data, 200);
        });
      })
      .catch(function () {
        renderStatus(null, 0);
      });
  }

  load();
  // Refresh the board; the page itself does not poll anything else.
  setInterval(load, 60000);
})();
