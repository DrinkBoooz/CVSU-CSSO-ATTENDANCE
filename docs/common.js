// Shared frontend utilities (DRY + KISS) for docs/index.html and docs/pass.html.
(function (global) {
  "use strict";

  const FALLBACK_API_URL =
    "https://script.google.com/macros/s/AKfycbwUMbXFKERYyNEWdGgDavVR4miCPD7OsDPBud_YsjSe3FbPdW-UiN26gclamX8UD_ou/exec";
  const GAS_EXEC_RE =
    /^https:\/\/script\.google\.com\/macros\/s\/[A-Za-z0-9_-]+\/exec$/;
  const LOCAL_API_RE =
    /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?\/[A-Za-z0-9_\/-]+$/;

  function resolveApiUrl() {
    const defaultUrl =
      (global.CSSO_CONFIG && global.CSSO_CONFIG.DEFAULT_API_URL) ||
      FALLBACK_API_URL;
    const isLocalHost =
      global.location.hostname === "127.0.0.1" ||
      global.location.hostname === "localhost";
    const rawParam = (
      new URLSearchParams(global.location.search).get("api") || ""
    ).trim();
    const isTrusted =
      GAS_EXEC_RE.test(rawParam) || (isLocalHost && LOCAL_API_RE.test(rawParam));
    return {
      apiUrl: isTrusted ? rawParam : defaultUrl,
      untrustedWarning: Boolean(rawParam && !isTrusted),
    };
  }

  function scopedKey(prefix, seed) {
    try {
      const hash = btoa(unescape(encodeURIComponent(String(seed || ""))))
        .replace(/[^A-Za-z0-9]/g, "")
        .slice(-16);
      return `${prefix}_${hash}`;
    } catch (e) {
      return prefix;
    }
  }

  function bindDeclarativeHandlers() {
    const parseCall = (spec) => {
      const m = /^\s*([A-Za-z_$][\w$]*)\s*\(([^)]*)\)\s*;?\s*$/.exec(spec || "");
      if (!m) return null;
      const args = m[2].trim()
        ? m[2].split(",").map((a) => {
            const t = a.trim();
            if (t === "event") return { ev: true };
            if (t === "true") return { v: true };
            if (t === "false") return { v: false };
            const s = /^'([^']*)'$/.exec(t) || /^"([^"]*)"$/.exec(t);
            return { v: s ? s[1] : t };
          })
        : [];
      return { fn: m[1], args };
    };
    ["click", "submit", "change"].forEach((evName) => {
      document.querySelectorAll("[data-on-" + evName + "]").forEach((el) => {
        const call = parseCall(el.getAttribute("data-on-" + evName));
        if (!call) return;
        el.addEventListener(evName, (ev) => {
          const fn = global[call.fn];
          if (typeof fn === "function") {
            fn.apply(
              null,
              call.args.map((a) => (a.ev ? ev : a.v)),
            );
          }
        });
      });
    });
  }

  function initFieldValidationAria(hintMap, trimIds) {
    const trimSet = new Set(trimIds || []);
    const sync = (el) => {
      if (!el || !el.matches || !el.matches("input, select, textarea")) return;
      let bad = false;
      try {
        bad = el.matches(":user-invalid");
      } catch (e) {
        bad = !el.validity.valid;
      }
      el.setAttribute("aria-invalid", bad ? "true" : "false");
      const hintId = (hintMap && hintMap[el.id]) || "";
      const errId = el.dataset.error;
      const ids = [];
      if (hintId) ids.push(hintId);
      if (bad && errId) ids.push(errId);
      if (ids.length) el.setAttribute("aria-describedby", ids.join(" "));
    };
    document.addEventListener(
      "blur",
      (e) => {
        if (
          e.target &&
          trimSet.has(e.target.id) &&
          typeof e.target.value === "string"
        ) {
          e.target.value = e.target.value.trim();
        }
        sync(e.target);
      },
      true,
    );
    document.addEventListener("input", (e) => {
      if (e.target && e.target.getAttribute("aria-invalid") === "true")
        sync(e.target);
    });
    document.addEventListener("invalid", (e) => sync(e.target), true);
  }

  function registerServiceWorker() {
    if ("serviceWorker" in navigator) {
      navigator.serviceWorker.register("./sw.js").catch(() => {});
    }
  }

  global.CSSOCommon = {
    resolveApiUrl,
    scopedKey,
    bindDeclarativeHandlers,
    initFieldValidationAria,
    registerServiceWorker,
  };
})(window);
