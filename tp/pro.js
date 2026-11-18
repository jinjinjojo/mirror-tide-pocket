/* Tide Pocket's free-tier rule, the only app-specific part of Pro (phone app only): the 6th saved place opens the shared paywall sheet (mobile/prism-paywall.js, configured by app.json
 * mobile.paywall) instead of saving. Capture phase, so it runs before the Save button's own handler. Removing a place is never blocked. */
(function (g) {
  "use strict";
  if (typeof document === "undefined") return;
  var saved = function () { try { return JSON.parse(localStorage.getItem("pw.saved") || "[]"); } catch (e) { return []; } };
  document.addEventListener("click", function (e) {
    var b = e.target.closest && e.target.closest(".pw-save"), a = g.PrismApp; if (!b || !a || !a.paywall || !a.paywall.enabled || !a.entitlements) return;
    if (a.paywall.gate({ pro: a.entitlements.has("pro"), count: saved().length, pressed: b.getAttribute("aria-pressed") === "true" })) { e.stopImmediatePropagation(); e.preventDefault(); a.paywall.open(); }
  }, true);
})(typeof window !== "undefined" ? window : globalThis);
