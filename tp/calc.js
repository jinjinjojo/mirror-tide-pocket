/* Tide maths that is not drawing: king tides, minus tides, how hard the water moves. Pure (calc.test.mjs runs it in Node). ev = [{ t (UTC ms), h (ft above MLLW), k: "H"|"L" }]. */
(function (g) {
  "use strict";
  var H = 36e5, D = 24 * H;
  /** kingTide(ev, now, mhhw): the highest predicted high in the next 3 days when it tops the station's mean higher high water by half a foot, else null. */
  function kingTide(ev, now, mhhw) {
    var hs = ev.filter(function (e) { return e.k === "H" && e.t > now - 2 * H && e.t < now + 3 * D; });
    if (!hs.length || mhhw == null) return null;
    var top = hs.reduce(function (a, b) { return b.h > a.h ? b : a; });
    return top.h - mhhw >= 0.5 ? { e: top, over: top.h - mhhw } : null;
  }
  /** isKingDay(day, mhhw): a day (from TPWindows.days) whose highest tide clears the same half foot. */
  function isKingDay(day, mhhw) { return mhhw != null && day.hi - mhhw >= 0.5; }
  /** minusTide(ev, now, days): the lowest predicted low below zero (MLLW) within the next `days` days, else null. Minus tides are what tide pools and clamming wait for. */
  function minusTide(ev, now, days) {
    var ls = ev.filter(function (e) { return e.k === "L" && e.h < 0 && e.t > now - 2 * H && e.t < now + (days || 7) * D; });
    return ls.length ? ls.reduce(function (a, b) { return b.h < a.h ? b : a; }) : null;
  }
  /** flow(prev, next, now): the curve is a half cosine, so the water's speed is a sine of how far we are between the last and next extreme: slack at each, fastest midway. { pct 0..100, word }. */
  function flow(prev, next, now) {
    var pct = Math.round(Math.max(0, Math.sin(Math.PI * (now - prev.t) / (next.t - prev.t))) * 100), rising = next.k === "H";
    return { pct: pct, word: pct < 20 ? "Slack water" : pct < 55 ? (rising ? "Building" : "Easing") : pct < 85 ? "Moving well" : "Running hard" };
  }
  /** conditions(raw, metric): what NOAA's latest readings say, as tiles [{ k, label, value, note }]. raw = { water, wind, pressure } are the CO-OPS "latest" answers (any may be missing: not every station has every sensor). Wind is in knots (what boats use), water in F or C. */
  function conditions(raw, metric) {
    var out = [], w = raw && raw.water && raw.water.data && raw.water.data[0], d = raw && raw.wind && raw.wind.data && raw.wind.data[0], p = raw && raw.pressure && raw.pressure.data && raw.pressure.data[0];
    if (w && isFinite(parseFloat(w.v))) { var f = parseFloat(w.v); out.push({ k: "water", label: "Water", value: metric ? ((f - 32) * 5 / 9).toFixed(1) + " C" : f.toFixed(0) + " F", note: "" }); }
    if (d && isFinite(parseFloat(d.s))) { var s = parseFloat(d.s), gust = parseFloat(d.g); out.push({ k: "wind", label: "Wind", value: s.toFixed(0) + " kn " + (d.dr || ""), note: isFinite(gust) && gust > s + 2 ? "gusts " + gust.toFixed(0) : "" }); }
    if (p && isFinite(parseFloat(p.v))) { var mb = parseFloat(p.v); out.push({ k: "pressure", label: "Pressure", value: mb.toFixed(0) + " mb", note: "" }); }
    return out;
  }
  g.TPCalc = { conditions: conditions, kingTide: kingTide, isKingDay: isKingDay, minusTide: minusTide, flow: flow };
})(typeof window !== "undefined" ? window : globalThis);
