/* Tide Pocket client: the station card (#tp-live), the home finder (#tp-home), the service worker and the install prompt.
 * Live data: NOAA CO-OPS predictions (public domain, CORS open), asked straight from the phone: no server of ours in the way.
 * Offline: the last answer per station is kept in localStorage, the pages and this file by sw.js. Mounts through a MutationObserver
 * so it also works after the Prism runtime swaps pages without a reload. */
(() => {
  "use strict";
  const API = "https://api.tidesandcurrents.noaa.gov/api/prod/datagetter";
  const H = 36e5, D = 864e5;
  const ls = { get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } }, set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* private mode: the app still works, nothing is remembered */ } } };
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const unit = () => ls.get("tp.unit", "ft");
  const fmtH = (ft) => (unit() === "m" ? (ft * 0.3048).toFixed(2) + " m" : ft.toFixed(1) + " ft");
  const clock = (localMs) => new Date(localMs).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: "UTC" });
  const dayName = (localMs, nowLocal) => { const a = Math.floor(localMs / D), b = Math.floor(nowLocal / D); return a === b ? "Today" : a === b + 1 ? "Tomorrow" : new Date(localMs).toLocaleDateString("en-US", { weekday: "long", timeZone: "UTC" }); };
  const rel = (ms) => { const m = Math.round(ms / 6e4); if (m < 1) return "now"; if (m < 60) return m + " min"; const h = Math.floor(m / 60), r = m % 60; return r ? `${h} h ${r} min` : `${h} h`; };
  const relIn = (ms) => (rel(ms) === "now" ? "now" : "in " + rel(ms));
  const ago = (t) => { const m = Math.round((Date.now() - t) / 6e4); return m < 1 ? "just now" : m < 60 ? m + " min ago" : m < 1440 ? Math.round(m / 60) + " h ago" : Math.round(m / 1440) + " d ago"; };
  const ymd = (ms) => new Date(ms).toISOString().slice(0, 10).replace(/-/g, "");

  /* ---------- data: two hi/lo requests (UTC and station-local) give the exact local offset, DST included ---------- */
  const parse = (t) => { const m = /^(\d+)-(\d+)-(\d+) (\d+):(\d+)$/.exec(t); return m ? Date.UTC(+m[1], m[2] - 1, +m[3], +m[4], +m[5]) : NaN; };
  const q = (id, tz, a, b) => `${API}?product=predictions&application=prism-tide-pocket&datum=MLLW&station=${id}&time_zone=${tz}&units=english&interval=hilo&format=json&begin_date=${ymd(a)}&end_date=${ymd(b)}`;
  async function get(url) { const r = await fetch(url, { signal: AbortSignal.timeout(12000) }); if (!r.ok) throw new Error("HTTP " + r.status); const j = await r.json(); if (j.error) throw new Error(j.error.message || "no data"); return j.predictions || []; }
  /** tides(id): { events: [{ t (UTC ms), l (station-local ms), h (ft), k: "H"|"L" }], at, stale }. Fresh network answer, else the saved one, else throws. */
  async function tides(id, force) {
    const key = "tp.t." + id, saved = ls.get(key, null), now = Date.now();
    if (saved && !force && now - saved.at < 30 * 6e4) return { ...saved, stale: navigator.onLine === false };
    try {
      const a = now - D, b = now + 8 * D, [g, l] = await Promise.all([get(q(id, "gmt", a, b)), get(q(id, "lst_ldt", a, b))]);
      if (!g.length || !l.length) throw new Error("This station has no predictions right now.");
      const events = pair(g, l);
      if (!events.length) throw new Error("This station has no predictions right now.");
      const out = { events, at: now }; ls.set(key, out); return { ...out, stale: false };
    } catch (e) { if (saved) return { ...saved, stale: true, why: e.message }; throw e; }
  }
  /** pair(g, l): each UTC event with its station-local time. The two requests cover different day windows, so they are matched by height and kind, not by position. */
  function pair(g, l) {
    const loc = l.map((p) => ({ l: parse(p.t), v: p.v, k: p.type })), out = [];
    for (const p of g) { const t = parse(p.t), m = loc.filter((x) => x.v === p.v && x.k === p.type && Math.abs(x.l - t) < 15 * H).sort((a, b) => Math.abs(a.l - t) - Math.abs(b.l - t))[0]; if (m) out.push({ t, l: m.l, h: +p.v, k: p.type }); }
    return out;
  }
  const offAt = (ev, now) => { let best = ev[0]; for (const e of ev) if (Math.abs(e.t - now) < Math.abs(best.t - now)) best = e; return best.l - best.t; };
  /** heightAt(events, t): the tide curve between extremes is a half cosine, the standard way tide tables are read. */
  function heightAt(ev, t) { for (let i = 0; i < ev.length - 1; i++) { const a = ev[i], b = ev[i + 1]; if (t >= a.t && t <= b.t) return a.h + (b.h - a.h) * (1 - Math.cos(Math.PI * (t - a.t) / (b.t - a.t))) / 2; } return null; }
  function summary(data) {
    const ev = data.events, now = Date.now(), off = offAt(ev, now), i = ev.findIndex((e) => e.t > now);
    if (i < 1) return null;
    const next = ev[i], prev = ev[i - 1], h = heightAt(ev, now);
    return { ev, now, off, next, prev, h, rising: next.k === "H", nextLeft: next.t - now };
  }

  /** mhhw(id): the station's mean higher high water (NOAA datums, MLLW based like the predictions), asked once and kept for good: a datum does not change. */
  async function mhhw(id) {
    const k = "tp.mhhw." + id, v = ls.get(k, null); if (v != null) return v;
    const j = await get(`https://api.tidesandcurrents.noaa.gov/mdapi/prod/webapi/stations/${id}/datums.json?units=english`), d = (j.datums || []).find((x) => x.name === "MHHW");
    if (!d) throw new Error("no datum"); ls.set(k, +d.value); return +d.value;
  }
  /** specialTides(el, s, mh): fills the strip under the hero number with a king tide (needs the datum) and a minus tide (needs nothing), and marks those days on the week bars. */
  const specialTides = (el, s, mh) => { const C = window.TPCalc, slot = el.querySelector("[data-king]"); if (!C || !slot) return; const k = C.kingTide(s.ev, s.now, mh), m = C.minusTide(s.ev, s.now, 7), amt = (ft) => (unit() === "m" ? (ft * 0.3048).toFixed(2) + " m" : ft.toFixed(1) + " ft"), when = (e) => esc(dayName(e.l, s.now + s.off)) + " " + clock(e.l), out = [];
    if (k) out.push('<p><em class="tp-pill king">King tide</em> <span>' + when(k.e) + ", " + esc(amt(k.over)) + " above a normal high</span></p>");
    if (m) out.push('<p><em class="tp-pill minus">Minus tide</em> <span>' + when(m) + ", " + esc(amt(m.h)) + " (tide pools and clamming)</span></p>");
    if (out.length) { slot.hidden = false; slot.innerHTML = out.join(""); }
    const W = window.TPWindows, bars = el.querySelectorAll(".tp-wd"); if (W && bars.length) W.days(s.ev, s.now, s.off, 7).forEach((x, n) => { const b = bars[n]?.querySelector(".tp-wb"); if (!b) return; if (C.isKingDay(x, mh)) b.insertAdjacentHTML("afterbegin", '<u class="tp-wm king" title="King tide">&#9650;</u>'); else if (x.lo < 0) b.insertAdjacentHTML("afterbegin", '<u class="tp-wm minus" title="Minus tide">&#9660;</u>'); }); };
  /** obs(id): the latest water temperature, wind and pressure NOAA measures at the station itself (many stations have none: those tiles are simply left out). Kept 30 minutes. */
  async function obs(id) {
    const key = "tp.o." + id, saved = ls.get(key, null); if (saved && Date.now() - saved.at < 30 * 6e4) return saved.raw;
    const one = (p) => fetch(`${API}?product=${p}&application=prism-tide-pocket&station=${id}&date=latest&units=english&time_zone=gmt&format=json`, { signal: AbortSignal.timeout(12000) }).then((r) => r.json()).then((j) => ({ data: j.data || [] }), () => null);
    const [water, wind, pressure] = await Promise.all([one("water_temperature"), one("wind"), one("air_pressure")]), raw = { water, wind, pressure };
    ls.set(key, { raw, at: Date.now() }); return raw;
  }
  const obsCard = (tiles) => tiles.length ? '<div class="tp-card tp-obs"><p class="tp-eyebrow" style="margin:0 0 8px">At the water now</p><div class="tp-obs-row">' + tiles.map((t) => "<span><small>" + t.label + "</small><b>" + esc(t.value) + "</b>" + (t.note ? "<em>" + esc(t.note) + "</em>" : "") + "</span>").join("") + "</div></div>" : "";
  /** flowCard(s): the meter under "Right now" (the maths is TPCalc.flow). */
  const flowCard = (s) => { const C = window.TPCalc; if (!C) return ""; const f = C.flow(s.prev, s.next, s.now);
    return '<div class="tp-flow" aria-label="Water movement: ' + f.word + '"><span class="tp-flow-t"><small>Tide flow</small><b>' + f.word + '</b></span><span class="tp-flow-bar" aria-hidden="true"><i style="width:' + Math.max(4, f.pct) + '%"></i></span><span class="tp-flow-n">Slack ' + relIn(s.nextLeft) + "</span></div>"; };
  /** skyCard(el, s): sunrise, sunset and the moon for this station today, from its place (data-lat, data-lng) and the clock offset of its own tide times. */
  const skyCard = (el, s) => { const T = window.TPSun, lat = +el.dataset.lat, lng = +el.dataset.lng; if (!T || !el.dataset.lat || !isFinite(lat) || !isFinite(lng)) return ""; const st = T.sunTimes(s.now, lat, lng), m = T.moon(s.now), hm = (t) => clock(t + s.off);
    return `<div class="tp-card tp-sky"><p class="tp-eyebrow" style="margin:0">Sun and moon</p><div class="tp-sky-row"><span><small>Sunrise</small><b>${st ? hm(st.rise) : "None today"}</b></span><span><small>Sunset</small><b>${st ? hm(st.set) : "None today"}</b></span><span><small>Moon</small><b>${esc(m.name)}, ${m.lit}%</b></span></div></div>`; };

  /** goodTimes(el, s): fishing and tide-pool windows from windows.js, in the station's own clock. */
  const goodTimes = (el, s) => { const W = window.TPWindows; if (!W) return ""; const lat = +el.dataset.lat, lng = +el.dataset.lng, p = W.plan(s.ev, { now: s.now, lat, lng, sun: window.TPSun });
    const day = (t) => dayName(t + s.off, s.now + s.off), rng = (a, b) => clock(a + s.off) + " to " + clock(b + s.off);
    const rows = (title, list, note) => list.length ? '<p class="tp-wh">' + title + "</p>" + list.map((w) => '<p class="tp-gr"><b>' + esc(day(w.from)) + "</b><span>" + esc(rng(w.from, w.to)) + "</span>" + note(w) + "</p>").join("") : "";
    const lv = ls.get("tp.boat", 3), above = W.above(s.ev, lv, s.now, 48).filter((w) => w.to - w.from >= 30 * 6e4).slice(0, 3), lvOpts = [2, 3, 4, 5, 6, 8].map((n) => '<option value="' + n + '"' + (n === lv ? " selected" : "") + ">" + n + " ft</option>").join("");
    const boat = '<p class="tp-wh">Boating</p><label class="tp-lv">Tide at least <select data-boat aria-label="Tide height needed">' + lvOpts + "</select></label>" + (above.length ? above.map((w) => '<p class="tp-gr"><b>' + esc(day(w.from)) + "</b><span>" + esc(rng(w.from, w.to)) + "</span></p>").join("") : "<p><span>Not in the next 2 days at this station.</span></p>");
    return '<div class="tp-card tp-win"><p class="tp-eyebrow" style="margin:0">Good times</p>' + rows("Fishing: water moving fastest", p.fishing, (w) => (w.near ? '<em class="tp-pill">' + esc(w.near) + "</em>" : "")) + rows("Tide pools: a low in daylight", p.pools, (w) => '<em class="tp-pill">low ' + esc(fmtH(w.low)) + "</em>") + boat + '<p class="tp-cap">A rule of thumb from the tide table, not a promise.</p></div>'; };

  /** spark(s): a small curve of the next 24 hours for the home card, with a dot for now. */
  const spark = (s) => { const t0 = s.now - 2 * H, t1 = s.now + 24 * H, pts = []; for (let t = t0; t <= t1; t += 30 * 6e4) { const h = heightAt(s.ev, t); if (h != null) pts.push([t, h]); } if (pts.length < 4) return ""; const lo = Math.min(...pts.map((p) => p[1])), hi = Math.max(...pts.map((p) => p[1])), sp = hi - lo || 1, X = (t) => ((t - t0) / (t1 - t0)) * 300, Y = (h) => 6 + (1 - (h - lo) / sp) * 58;
    return '<svg class="tp-spark" viewBox="0 0 300 70" preserveAspectRatio="none" aria-hidden="true"><path d="' + pts.map((p, i) => (i ? "L" : "M") + X(p[0]).toFixed(1) + " " + Y(p[1]).toFixed(1)).join("") + 'L300 70L0 70Z" fill="var(--accent,#2dd4bf)" fill-opacity=".14" stroke="none"/><circle cx="' + X(s.now).toFixed(1) + '" cy="' + Y(s.h).toFixed(1) + '" r="3.5" fill="var(--fg,#fff)" vector-effect="non-scaling-stroke"/><path d="' + pts.map((p, i) => (i ? "L" : "M") + X(p[0]).toFixed(1) + " " + Y(p[1]).toFixed(1)).join("") + '" fill="none" stroke="var(--accent,#2dd4bf)" stroke-width="2" vector-effect="non-scaling-stroke" stroke-linecap="round"/></svg>'; };
  const BELL = "<svg aria-hidden='true' viewBox='0 0 24 24' width='20' height='20' fill='none' stroke='currentColor' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'><path d='M6 9a6 6 0 0 1 12 0c0 7 3 8 3 8H3s3-1 3-8'/><path d='M10 21a2 2 0 0 0 4 0'/></svg>";
  /** countUp(b): the big number counts up from zero once, ease-out, unless the person asked for less motion. The final text is what a screen reader and the tests read. */
  const countUp = (b) => { const txt = b?.textContent || "", to = parseFloat(txt); if (!isFinite(to) || matchMedia("(prefers-reduced-motion: reduce)").matches) return; const dec = (txt.split(".")[1] || "").length, t0 = performance.now(), D2 = 650;
    b.setAttribute("aria-label", txt); const step = (t) => { const k = Math.min(1, Math.max(0, (t - t0) / D2)), e = 1 - Math.pow(1 - k, 3); b.textContent = (to * e).toFixed(dec); if (k < 1) requestAnimationFrame(step); else b.textContent = txt; }; requestAnimationFrame(step); };
  /** mini(s): a 64 by 24 curve of the next 24 hours for a list row. */
  const mini = (s) => { const t0 = s.now, t1 = s.now + 24 * H, pts = []; for (let t = t0; t <= t1; t += 60 * 6e4) { const h = heightAt(s.ev, t); if (h != null) pts.push(h); } if (pts.length < 4) return ""; const lo = Math.min(...pts), hi = Math.max(...pts), sp = hi - lo || 1;
    return '<svg class="tp-mini" viewBox="0 0 64 24" preserveAspectRatio="none" aria-hidden="true"><path d="' + pts.map((h, i) => (i ? "L" : "M") + ((i / (pts.length - 1)) * 64).toFixed(1) + " " + (3 + (1 - (h - lo) / sp) * 18).toFixed(1)).join("") + '" fill="none" stroke="var(--accent,#2dd4bf)" stroke-width="1.6" stroke-linecap="round" vector-effect="non-scaling-stroke"/></svg>'; };
  /** weekCard(s): the next 7 days as bars from the day's lowest to its highest tide, so big and small tides (springs and neaps) show at a glance. */
  const weekCard = (s) => { const W = window.TPWindows; if (!W) return ""; const ds = W.days(s.ev, s.now, s.off, 7); if (ds.length < 4) return ""; const lo = Math.min(...ds.map((x) => x.lo)), hi = Math.max(...ds.map((x) => x.hi)), sp = hi - lo || 1, big = Math.max(...ds.map((x) => x.range)), small = Math.min(...ds.map((x) => x.range)), bigDay = ds.find((x) => x.range === big), isBig = big >= small * 1.3 && big - small >= 0.8, nm = (x) => new Date(x.day).toLocaleDateString("en-US", { weekday: "long", timeZone: "UTC" });
    return '<div class="tp-card"><p class="tp-eyebrow" style="margin:0 0 8px">This week' + (isBig ? ' <em class="tp-pill big">Big tide ' + esc(bigDay === ds[0] ? "today" : nm(bigDay)) + "</em>" : "") + '</p><div class="tp-week" role="img" aria-label="Daily tide range for the next 7 days">' + ds.map((x, i) => '<div class="tp-wd"><small>' + (i === 0 ? "Today" : new Date(x.day).toLocaleDateString("en-US", { weekday: "short", timeZone: "UTC" })) + '</small><span class="tp-wb"><i style="bottom:' + (((x.lo - lo) / sp) * 100).toFixed(1) + "%;height:" + Math.max(6, (x.range / sp) * 100).toFixed(1) + '%"' + (x.range === big ? ' class="big"' : "") + '></i></span><b>' + esc(fmtH(x.hi).replace(/ (ft|m)$/, "")) + '</b><small>' + esc(fmtH(x.lo).replace(/ (ft|m)$/, "")) + "</small></div>").join("") + '</div><p class="tp-cap">Highest tide above each bar, lowest below.' + (isBig ? " Brightest: the biggest swing, " + esc(fmtH(big)) + " from low to high." : "") + '</p></div>'; };

  /* ---------- tide alarm (phone app only): local notifications scheduled ahead from the predictions ---------- */
  const LN = () => window.Capacitor?.isNativePlatform?.() && window.Capacitor.Plugins?.LocalNotifications && window.TPAlarm ? window.Capacitor.Plugins.LocalNotifications : null;
  const alarmOf = (id) => ls.get("tp.alarm." + id, null);
  async function schedule(id, name, events) {
    const N = LN(); if (!N) return 0;
    const old = ls.get("tp.alarm.ids." + id, []); if (old.length) await N.cancel({ notifications: old.map((x) => ({ id: x })) }).catch(() => {});
    const a = alarmOf(id); if (!a) { ls.set("tp.alarm.ids." + id, []); return 0; }
    const now0 = Date.now(), off0 = offAt(events, now0), ll = ls.get("tp.ll." + id, null); // fishing windows need the station's place for sunrise and sunset
    const plan = a.kind === "fish" ? (window.TPWindows && ll ? window.TPAlarm.fishPlan(window.TPWindows.plan(events, { now: now0, lat: ll[0], lng: ll[1], sun: window.TPSun, hours: 168, max: 14 }).fishing, { station: id, name, lead: a.lead, now: now0, fmtRange: (f, t) => clock(f + off0) + " to " + clock(t + off0) }) : []) : window.TPAlarm.plan(events, { station: id, name, kind: a.kind, lead: a.lead, now: now0, fmtTime: clock, fmtHeight: fmtH });
    if (plan.length) await N.schedule({ notifications: plan.map((p) => ({ id: p.id, title: p.title, body: p.body, schedule: { at: new Date(p.at), allowWhileIdle: true } })) });
    ls.set("tp.alarm.ids." + id, plan.map((p) => p.id)); return plan.length;
  }
  const alarmPanel = (id) => { const a = alarmOf(id) || { kind: "H", lead: 30 }, on = !!alarmOf(id);
    return `<div class="tp-alarm" data-alarmbox hidden><label class="field">Alert me for<select data-ak><option value="H" ${a.kind === "H" ? "selected" : ""}>High tides</option><option value="L" ${a.kind === "L" ? "selected" : ""}>Low tides</option><option value="both" ${a.kind === "both" ? "selected" : ""}>Both</option><option value="fish" ${a.kind === "fish" ? "selected" : ""}>Fishing windows</option></select></label>
      <label class="field">How early<select data-al>${[[0, "At the tide"], [15, "15 min before"], [30, "30 min before"], [60, "1 hour before"], [120, "2 hours before"]].map(([m, t]) => `<option value="${m}" ${a.lead === m ? "selected" : ""}>${t}</option>`).join("")}</select></label>
      <div class="tp-bar" style="margin:0"><button class="tp-btn pri" data-alarmon>${on ? "Update alarm" : "Turn on"}</button>${on ? '<button class="tp-btn" data-alarmoff>Turn off</button>' : ""}</div><p class="tp-foot" data-am>Notifications for the next 7 days; they are renewed whenever you open this station.</p></div>`; };

  /* ---------- the station card ---------- */
  const skeleton = () => `<div class="tp-card" aria-busy="true" aria-label="Loading tide times"><span class="tp-skel" style="height:16px;width:40%"></span><span class="tp-skel" style="height:56px;width:55%;margin-top:14px"></span><span class="tp-skel" style="height:18px;width:80%;margin-top:14px"></span><span class="tp-skel" style="height:140px;margin-top:16px"></span></div>`;
  /** friendly(msg): what a person can act on, never the browser's raw words. */
  const friendly = (m) => (navigator.onLine === false ? "You are offline, and this station has not been opened on this phone before." : /fetch|network|abort|timeout|HTTP/i.test(m) ? "NOAA could not be reached. Check your connection, then try again." : m);
  const errorCard = (msg, retry) => `<div class="tp-card tp-err" role="alert"><h3>Tide times did not load</h3><p>${esc(friendly(msg))}</p><div class="tp-bar"><button class="tp-btn pri" data-retry>Try again</button></div></div>`;

  function chart(s, el) {
    const W = 360, Ht = 236, top = 46, bot = 172, base = 200, t0 = s.now - 6 * H, t1 = s.now + 30 * H, pts = [];
    for (let t = t0; t <= t1; t += 15 * 6e4) { const h = heightAt(s.ev, t); if (h != null) pts.push([t, h]); }
    if (pts.length < 3) return "";
    const lo = Math.min(...pts.map((p) => p[1])), hi = Math.max(...pts.map((p) => p[1])), span = hi - lo || 1;
    const x = (t) => ((t - t0) / (t1 - t0)) * W, y = (h) => top + (1 - (h - lo) / span) * (bot - top);
    const d = pts.map((p, i) => (i ? "L" : "M") + x(p[0]).toFixed(1) + " " + y(p[1]).toFixed(1)).join("");
    const tshort = (l2) => clock(l2).replace(" AM", "a").replace(" PM", "p"); let lastX = -99;
    const labels = s.ev.filter((e) => e.t > t0 && e.t < t1).map((e) => { const px = Math.min(W - 24, Math.max(24, x(e.t))); if (px - lastX < 50 || Math.abs(px - x(s.now)) < 24) return ""; lastX = px; const hi2 = e.k === "H", yy = y(e.h); // height and time stack beside the extreme; a label too close to the one before is left out (the list below has them all)
      return '<text class="lh" x="' + px.toFixed(1) + '" y="' + (hi2 ? yy - 19 : yy + 15).toFixed(1) + '" text-anchor="middle">' + esc(fmtH(e.h)) + '</text><text class="lt" x="' + px.toFixed(1) + '" y="' + (hi2 ? yy - 7 : yy + 27).toFixed(1) + '" text-anchor="middle">' + esc(tshort(e.l)) + "</text>"; }).join("");
    const days = []; for (let t = Math.ceil((t0 + s.off) / D) * D - s.off; t < t1; t += D) { const px = x(t); if (px > 14) days.push('<line class="dl" x1="' + px.toFixed(1) + '" x2="' + px.toFixed(1) + '" y1="' + base + '" y2="' + (Ht - 2) + '"/><text class="day" x="' + (px + 5).toFixed(1) + '" y="' + (Ht - 3) + '">' + new Date(t + s.off).toLocaleDateString("en-US", { weekday: "short", timeZone: "UTC" }) + "</text>"); }
    const ticks = []; for (let t = Math.ceil((t0 + s.off) / (6 * H)) * 6 * H - s.off; t < t1; t += 6 * H) { const px = x(t), hr = new Date(t + s.off).getUTCHours(); if (px < 10 || px > W - 10) continue; ticks.push('<line class="tk" x1="' + px.toFixed(1) + '" x2="' + px.toFixed(1) + '" y1="' + base + '" y2="' + (base + 4) + '"/>' + (hr % 12 === 0 && hr !== 0 ? "" : "") + '<text class="tkl" x="' + px.toFixed(1) + '" y="' + (base + 15) + '" text-anchor="middle">' + (hr === 0 ? "" : hr === 12 ? "12p" : hr < 12 ? hr + "a" : hr - 12 + "p") + "</text>"); }
    const lat = +el?.dataset.lat, lng = +el?.dataset.lng, T = window.TPSun; let night = ""; // dusk to dawn is shaded: the water looks different in the dark and so does the fishing
    if (T && el?.dataset.lat && isFinite(lat) && isFinite(lng)) for (let k = -1; k < 3; k++) { const a = T.sunTimes(s.now + k * D, lat, lng), b = T.sunTimes(s.now + (k + 1) * D, lat, lng); if (!a || !b) continue; const from = Math.max(a.set, t0), to = Math.min(b.rise, t1); if (to > from) night += '<rect class="night" x="' + x(from).toFixed(1) + '" y="0" width="' + (x(to) - x(from)).toFixed(1) + '" height="' + base + '"/>'; }
    const nx = x(s.now), ny = y(s.h), left = nx < W - 40;
    return '<svg class="tp-chart" viewBox="0 0 ' + W + " " + Ht + '" role="img" aria-label="Tide height for the next 30 hours" data-t0="' + t0 + '" data-t1="' + t1 + '" data-off="' + s.off + '" data-lo="' + lo + '" data-sp="' + span + '" data-top="' + top + '" data-bot="' + bot + '" data-w="' + W + '"><defs><linearGradient id="tpg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="var(--accent,#2dd4bf)" stop-opacity=".35"/><stop offset="1" stop-color="var(--accent,#2dd4bf)" stop-opacity="0"/></linearGradient></defs>' +
      night + '<path class="area" d="' + d + "L" + x(pts[pts.length - 1][0]).toFixed(1) + " " + base + "L" + x(pts[0][0]).toFixed(1) + " " + base + 'Z"/><rect class="past" x="0" y="0" width="' + nx.toFixed(1) + '" height="' + base + '"/><path class="line" pathLength="1" d="' + d + '"/>' +
      '<line class="now" x1="' + nx.toFixed(1) + '" x2="' + nx.toFixed(1) + '" y1="16" y2="' + base + '"/><text class="nowl" x="' + (left ? nx + 5 : nx - 5).toFixed(1) + '" y="12" text-anchor="' + (left ? "start" : "end") + '">Now</text>' + labels + ticks.join("") + days.join("") +
      '<g class="scrub" hidden><line x1="0" x2="0" y1="16" y2="' + base + '"/><circle r="5" cx="0" cy="0"/><g class="tip"><rect rx="8" width="96" height="24" y="-30"/><text y="-14" x="48" text-anchor="middle"></text></g></g><circle class="ring" cx="' + nx.toFixed(1) + '" cy="' + ny.toFixed(1) + '" r="8"/><circle class="dot" cx="' + nx.toFixed(1) + '" cy="' + ny.toFixed(1) + '" r="5"/></svg>';
  }
  function list(s) {
    let out = "", cur = "";
    for (const e of s.ev.filter((e) => e.t > s.now - 3 * H && e.l < s.now + s.off + 7 * D)) {
      const dn = dayName(e.l, s.now + s.off);
      if (dn !== cur) { out += (cur ? "</ul>" : "") + `<h3>${esc(dn)}</h3><ul class="tp-days" style="margin:0">`; cur = dn; }
      out += `<li class="tp-row ${e.k}${e.t < s.now ? " past" : ""}"><i aria-hidden="true">${e.k === "H" ? "H" : "L"}</i><span>${e.k === "H" ? "High tide" : "Low tide"}</span><small>${esc(fmtH(e.h))}</small><b>${clock(e.l)}</b></li>`;
    }
    return out + "</ul>";
  }
  async function mountLive(el) {
    const id = el.dataset.id; if (el.dataset.lat) ls.set("tp.ll." + id, [+el.dataset.lat, +el.dataset.lng]); const name = (document.querySelector("h1")?.textContent || "").replace(/^[$#\s~/]*Tide times at\s*/i, "").trim() || "this station";
    if (document.documentElement.classList.contains("native") && window.TPNames && !el.previousElementSibling?.classList.contains("tp-head")) { // the app's title row: a back arrow, the short name and where it is (the long page title stays for search engines and screen readers)
      const sn = window.TPNames.short(name), h = document.createElement("div"); h.className = "tp-head";
      const b = document.createElement("button"); b.className = "tp-back"; b.setAttribute("aria-label", "Back"); b.innerHTML = '<svg viewBox="0 0 24 24" width="24" height="24" aria-hidden="true"><path d="M15 5l-7 7 7 7" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>'; b.onclick = () => (history.length > 1 ? history.back() : (location.href = "/index.html"));
      const t = document.createElement("div"), a = document.createElement("p"), s2 = document.createElement("p"); a.className = "tp-title"; a.textContent = sn.title; s2.className = "tp-subt"; s2.textContent = sn.sub; t.append(a, s2); t.style.minWidth = "0"; const hl = document.createElement("div"); hl.className = "tp-hl"; h.append(b, t, hl); const sc = () => { const bar = document.querySelector("header"), r = bar ? bar.getBoundingClientRect() : null; if (r && getComputedStyle(bar).position !== "static") h.style.top = Math.max(0, r.bottom - 1) + "px"; const sc2 = h.classList.toggle("scrolled", scrollY > 170); if (!h._bg) { const c = getComputedStyle(document.body).backgroundColor; if (c && !/rgba\(.*, 0\)|transparent/.test(c)) { h._bg = c; h.style.setProperty("--hbg", c); } } }; sc(); addEventListener("scroll", sc, { passive: true }); el.before(h); requestAnimationFrame(() => { const bar = document.querySelector("header"), gap = h.getBoundingClientRect().top - (bar ? bar.getBoundingClientRect().bottom : 0); if (gap > 12) h.style.marginTop = "-" + (gap - 12) + "px"; });
      const mv = () => { const sv = document.querySelector(".pw-save"); if (sv && !h.contains(sv)) { sv.classList.add("tp-headsave"); h.append(sv); } return !!sv; }; // Prism's Save button joins the title row
      if (!mv()) { const mo = new MutationObserver(() => { if (mv()) mo.disconnect(); }); mo.observe(document.body, { childList: true, subtree: true }); setTimeout(() => mo.disconnect(), 6000); }
    }
    const paint = async (force) => {
      el.innerHTML = skeleton();
      let data;
      try { data = await tides(id, force); } catch (e) { el.innerHTML = errorCard(e.message, true); return; }
      const s = summary(data); el._s = s;
      if (s && LN() && alarmOf(id)) schedule(id, name, s.ev).catch(() => {}); // renew the next 7 days of alarms each time the station is opened
      if (!s) { el.innerHTML = `<div class="tp-card tp-err"><h3>No tides to show</h3><p>NOAA returned no upcoming tides for this station. Try again later or pick a nearby station.</p></div>`; return; }
            el.innerHTML = `<div class="tp-card tp-hero">${data.stale ? `<p class="tp-note">Offline: showing times saved ${ago(data.at)}.</p>` : ""}
        <p class="tp-eyebrow">Next ${s.next.k === "H" ? "high" : "low"} tide</p><p class="tp-big"><b>${esc(fmtH(s.next.h).replace(/ (ft|m)$/, ""))}</b><span>${unit()}</span></p>
        <p class="tp-next"><b>${clock(s.next.l)}</b> &middot; ${relIn(s.nextLeft)}</p>
        <p class="tp-king" data-king hidden></p><p class="tp-now-row">Right now <b>${esc(fmtH(s.h))}</b> <i class="tp-trend ${s.rising ? "up" : "dn"}">${s.rising ? "&#9650; Rising" : "&#9660; Falling"}</i></p>${flowCard(s)}${chart(s, el)}
        <div class="tp-bar"><button class="tp-btn" data-unit aria-label="Switch between feet and meters">${unit() === "ft" ? "Show meters" : "Show feet"}</button>${navigator.share ? `<button class="tp-btn" data-share>Share</button>` : ""}${LN() ? `<button class="tp-btn" data-alarm aria-pressed="${!!alarmOf(id)}">${alarmOf(id) ? "<svg aria-hidden='true' viewBox='0 0 24 24' width='18' height='18' fill='none' stroke='currentColor' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'><path d='M6 9a6 6 0 0 1 12 0c0 7 3 8 3 8H3s3-1 3-8'/><path d='M10 21a2 2 0 0 0 4 0'/></svg> Alarm on" : "<svg aria-hidden='true' viewBox='0 0 24 24' width='18' height='18' fill='none' stroke='currentColor' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'><path d='M6 9a6 6 0 0 1 12 0c0 7 3 8 3 8H3s3-1 3-8'/><path d='M10 21a2 2 0 0 0 4 0'/></svg> Tide alarm"}</button>` : ""}</div>${LN() ? alarmPanel(id) : ""}</div>
        <div data-obs></div><div class="tp-gt">${goodTimes(el, s)}</div>${weekCard(s)}${skyCard(el, s)}
        <div class="tp-card"><p class="tp-eyebrow" style="margin:0">Next 7 days</p>${list(s)}<p class="tp-foot">NOAA station ${esc(id)} &middot; times are local to the station &middot; updated ${ago(data.at)}</p></div>`; scrubWire(); obs(id).then((r) => { const o = el.querySelector("[data-obs]"); if (o && window.TPCalc) o.innerHTML = obsCard(window.TPCalc.conditions(r, unit() === "m")); }).catch(() => {}); specialTides(el, s, null); mhhw(id).then((m) => specialTides(el, s, m)).catch(() => {}); const hl = document.querySelector(".tp-hl"); if (hl) hl.innerHTML = "<b>" + esc(fmtH(s.h)) + "</b>" + (s.rising ? "&#9650; Rising" : "&#9660; Falling"); if (!el._cu) { el._cu = 1; countUp(el.querySelector(".tp-hero .tp-big b")); }
    };
    el.onchange = (e) => { if (e.target.matches?.("[data-boat]")) { ls.set("tp.boat", +e.target.value); const g2 = el.querySelector(".tp-gt"); if (g2 && el._s) g2.innerHTML = goodTimes(el, el._s); } };
    /** scrub(svg): drag a finger along the chart and read the height and time under it (vertical scrolling still works). */
    const scrubWire = () => { const svg = el.querySelector("svg.tp-chart"), g = svg?.querySelector(".scrub"); if (!svg || !g || svg._w) return; svg._w = 1; const d = svg.dataset, t0 = +d.t0, t1 = +d.t1, off = +d.off, lo = +d.lo, sp = +d.sp, top = +d.top, bot = +d.bot, W = +d.w;
      const at = (e) => { const r = svg.getBoundingClientRect(), px = Math.min(W, Math.max(0, ((e.clientX - r.left) / r.width) * W)), t = t0 + (px / W) * (t1 - t0), h = el._s ? heightAt(el._s.ev, t) : null; if (h == null) return; const py = top + (1 - (h - lo) / sp) * (bot - top); g.hidden = false; g.querySelector("line").setAttribute("x1", px), g.querySelector("line").setAttribute("x2", px); const c = g.querySelector("circle"); c.setAttribute("cx", px); c.setAttribute("cy", py); const tip = g.querySelector(".tip"), tx = Math.min(W - 98, Math.max(2, px - 48)); tip.setAttribute("transform", "translate(" + tx + " " + Math.max(34, py - 10) + ")"); tip.querySelector("text").textContent = fmtH(h) + "  " + clock(t + off); const ex = el._s?.ev.find((e) => Math.abs(e.t - t) < 12 * 6e4); if (ex && ex !== svg._ex) window.PrismFeel?.haptic?.("light"); svg._ex = ex || null; }; // a tick under the finger at each high and low
      svg.addEventListener("pointerdown", (e) => { svg.setPointerCapture?.(e.pointerId); at(e); }); svg.addEventListener("pointermove", (e) => { if (e.buttons || e.pointerType === "touch") at(e); }); svg.addEventListener("pointerup", () => setTimeout(() => (g.hidden = true), 1800)); svg.addEventListener("pointercancel", () => (g.hidden = true)); };
    const cachedEvents = (sid) => ls.get("tp.t." + sid, { events: [] }).events;
    el.onclick = async (e) => {
      const b = e.target.closest("button"); if (!b) return;
      if (b.dataset.retry != null) paint(true);
      if (b.dataset.unit != null) { ls.set("tp.unit", unit() === "ft" ? "m" : "ft"); paint(false); }
      if (b.dataset.alarm != null) { const box = el.querySelector("[data-alarmbox]"); box.hidden = !box.hidden; }
      if (b.dataset.alarmoff != null) { ls.set("tp.alarm." + id, null); await schedule(id, name, cachedEvents(id)); paint(false); }
      if (b.dataset.alarmon != null) { const N = LN(), p = await N.requestPermissions().catch(() => null); if (p?.display !== "granted") { el.querySelector("[data-am]").textContent = "Notifications are off for this app. Allow them in the phone settings, then try again."; return; } ls.set("tp.alarm." + id, { kind: el.querySelector("[data-ak]").value, lead: +el.querySelector("[data-al]").value }); const n = await schedule(id, name, cachedEvents(id)); window.PrismApp?.push?.ask({ topics: ["tide-alerts"] }).catch(() => {}); paint(false); if (window.PrismFeel) window.PrismFeel.haptic("success"); }
      if (b.dataset.share != null) navigator.share({ title: document.title, url: location.href }).catch(() => {});
    };
    document.addEventListener("prism:refresh", () => paint(true)); // pull down from the top in the phone app
    paint(false).then(() => widgetFor(id, name)).catch(() => {}); document.addEventListener("prism:saved", () => widgetFor(id, name)); document.addEventListener("click", (e) => { if (e.target.closest?.(".pw-save")) setTimeout(() => widgetFor(id, name), 500); }); // saving a place puts it on the widget at once
    clearTimeout(el._t); el._t = setInterval(() => { if (document.body.contains(el)) paint(false); else clearInterval(el._t); }, 5 * 6e4);
  }

  /* ---------- the home finder ---------- */
  let stations = null;
  async function loadStations() { if (stations) return stations; const r = await fetch("/tp/stations.json"); stations = (await r.json()).s.map(([id, name, st, lat, lng]) => ({ id, name, st, lat, lng, key: (name + " " + st).toLowerCase() })); return stations; }
  const dist = (a, b, c, d) => { const R = 6371, r = Math.PI / 180, x = (c - a) * r, y = (d - b) * r, h = Math.sin(x / 2) ** 2 + Math.cos(a * r) * Math.cos(c * r) * Math.sin(y / 2) ** 2; return 2 * R * Math.asin(Math.sqrt(h)); };
  const miles = (km) => (km * 0.621371 < 10 ? (km * 0.621371).toFixed(1) : Math.round(km * 0.621371)) + " mi";
  const rowHtml = (s, extra) => `<li${extra?.rm ? ' class="tp-rmrow"' : ""}><a href="/station/${esc(s.id)}"><span${extra?.next ? "" : ' class="st-inline"'}><b>${esc(s.name)}</b><small>${esc(s.st)}${extra?.next ? " &middot; " + esc(extra.next) : ""}</small></span>${extra?.d != null ? `<em>${miles(extra.d)}</em>` : ""}<i class="tp-chev" aria-hidden="true">&rsaquo;</i></a>${extra?.rm ? `<button class="tp-rm" data-rm="${esc(s.id)}" aria-label="Remove ${esc(s.name)} from saved places">&times;</button>` : ""}</li>`;
  /** the home-screen widget shows the place the person saved and looked at last */
  const widgetFor = async (id, name) => { if (!window.PrismApp?.widget || !ls.get("pw.saved", []).some((x) => (x.p || "").startsWith(`/station/${id}`))) return; const t = await nextLine(id); if (t) window.PrismApp.widget.set({ title: name, line: t, when: `Updated ${new Date().toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`, route: `/station/${id}` }); };
  async function nextLine(id) { try { const s = summary(await tides(id)); return s ? `${s.next.k === "H" ? "High" : "Low"} ${fmtH(s.next.h)} ${relIn(s.nextLeft)}` : ""; } catch { return ""; } }

  let deferred = null;
  addEventListener("beforeinstallprompt", (e) => { e.preventDefault(); deferred = e; document.querySelectorAll("[data-install]").forEach((b) => (b.hidden = false)); });
  addEventListener("appinstalled", () => { deferred = null; document.querySelectorAll("[data-installbox]").forEach((b) => b.remove()); });
  const standalone = () => matchMedia("(display-mode: standalone)").matches || navigator.standalone || !!window.Capacitor?.isNativePlatform?.();

  async function mountHome(el) {
    const ios = /iphone|ipad/i.test(navigator.userAgent) && !standalone();
    const SEARCH = '<svg aria-hidden="true" viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><path d="M20 20l-4-4"/></svg>';
    el.innerHTML = '<p class="tp-note" id="tpOff" role="status" hidden>Offline: showing the tides saved on this phone.</p><a class="tp-card tp-now" id="tpNow" href="/" hidden aria-live="polite"></a>' +
      '<div class="tp-card tp-hero tp-ask" id="tpAsk" hidden><h2>Where do you watch the water?</h2><p data-askmsg>Share your location once and the closest station is always one tap away. It never leaves your phone.</p><button class="tp-btn pri" data-geo>Use my location</button><div class="tp-chips" id="tpChips" aria-label="Or pick a harbor"></div></div>' +
      '<label class="tp-search"><span class="sr-only" style="position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0)">Search tide stations</span>' + SEARCH + '<input type="search" id="tpQ" placeholder="Search a town, harbor or state" autocomplete="off"></label><div class="tp-card" id="tpResBox" hidden><ul class="tp-list" id="tpRes" aria-live="polite"></ul></div>' +
      '<div id="tpSaved" hidden><h2 class="tp-sec">Favorites</h2><ul class="tp-rail" id="tpSavedList"></ul></div>' +
      '<div id="tpNear" hidden></div>' +
      '<div class="tp-quiet" data-installbox ' + (standalone() ? "hidden" : "") + '><span>' + (ios ? "Add it to your home screen: tap Share, then Add to Home Screen." : "Keep it on your home screen. Opens instantly, works offline.") + '</span>' + (ios ? "" : '<button class="tp-btn pri" data-install hidden>Install</button>') + '</div>';
    if (document.documentElement.classList.contains("native")) requestAnimationFrame(() => { const bar = document.querySelector("header"), gap = el.getBoundingClientRect().top - (bar ? bar.getBoundingClientRect().bottom : 0); if (gap > 14) el.style.marginTop = "-" + (gap - 14) + "px"; });
    const by0 = (sid) => (stations?.find((x) => x.id === sid)?.name) || "this station";
    const near = el.querySelector("#tpNear"), res = el.querySelector("#tpRes"), qin = el.querySelector("#tpQ");
    const showSaved = async () => {
      const ids = ls.get("pw.saved", []).map((x) => /^\/station\/(\d+)/.exec(x.p)?.[1]).filter(Boolean).slice(0, 8), box = el.querySelector("#tpSaved"), ul = el.querySelector("#tpSavedList"); box.hidden = !ids.length; if (!ids.length) return;
      const all = await loadStations(), by = new Map(all.map((s) => [s.id, s]));
      const rows = ids.filter((i) => i !== el.dataset.nowId).map((i) => by.get(i)).filter(Boolean); // the big card above already shows this place
      ul.innerHTML = rows.map((x) => { const sn = window.TPNames ? window.TPNames.short(x.name, x.st) : { title: x.name, sub: x.st }; return '<li class="tp-fav"><a href="/station/' + esc(x.id) + '"><small>' + esc(sn.sub) + "</small><b>" + esc(sn.title) + '</b><span class="tp-favh">&nbsp;</span><em>&nbsp;</em></a><button class="tp-rm" data-rm="' + esc(x.id) + '" aria-label="Remove ' + esc(x.name) + ' from favorites">&times;</button>' + (LN() ? '<button class="tp-bell" data-bell="' + esc(x.id) + '" aria-pressed="' + !!alarmOf(x.id) + '" aria-label="Tide alerts for ' + esc(x.name) + '">' + BELL + "</button>" : "") + "</li>"; }).join("") + (ids.length < 5 ? '<li class="tp-fav tp-add"><button data-addplace>+ Add a place</button></li>' : "");
      if (location.hash === "#tpSaved") box.scrollIntoView({ block: "start" }); // "Choose places to keep" from the paywall lands here
      rows.forEach(async (x, n) => { try { const r = summary(await tides(x.id)), li = ul.children[n]; if (!r || !li) return; li.querySelector(".tp-favh").innerHTML = esc(fmtH(r.h)) + ' <i class="tp-trend ' + (r.rising ? "up" : "dn") + '">' + (r.rising ? "&#9650;" : "&#9660;") + "</i>"; li.querySelector("em").textContent = (r.next.k === "H" ? "High " : "Low ") + fmtH(r.next.h) + " " + relIn(r.nextLeft); } catch { /* offline and never opened: the card stays a name */ } });
      if (ids[0] && by.get(ids[0])) widgetFor(ids[0], by.get(ids[0]).name); // the home-screen widget follows the first saved place
    };
    /** showNow(): the first screen answers "what is the tide" for the person's own place: the first saved place, else the station nearest the shared location. With neither, it asks (location first, or a harbor to pick) instead of guessing a city. */
    const POP = ["8443970", "9414290", "9447130", "8724580", "8518750"], ask = el.querySelector("#tpAsk");
    const showAsk = async () => { ask.hidden = false; el.querySelector("#tpNow").hidden = true; const all = await loadStations(), by = new Map(all.map((x) => [x.id, x])); el.querySelector("#tpChips").innerHTML = POP.map((i) => by.get(i)).filter(Boolean).map((x) => { const sn = window.TPNames ? window.TPNames.short(x.name, x.st) : { title: x.name }; return '<a class="tp-chip" href="/station/' + esc(x.id) + '">' + esc(sn.title.replace(/ \(.*$/, "")) + "</a>"; }).join(""); };
    const showNow = async () => {
      const saved = ls.get("pw.saved", []).map((x) => /^\/station\/(\d+)/.exec(x.p)?.[1]).filter(Boolean), g = ls.get("tp.geo", null), all = await loadStations(), by = new Map(all.map((x) => [x.id, x]));
      let id = saved.find((i) => by.has(i)), why = "Your saved place";
      if (!id && g) { id = all.map((x) => ({ s: x, d: dist(g[0], g[1], x.lat, x.lng) })).sort((a, b) => a.d - b.d)[0]?.s.id; why = "Closest to you"; }
      if (!id) return showAsk();
      ask.hidden = true;
      const st = by.get(id), box = el.querySelector("#tpNow"); if (!st) return; el.dataset.nowId = id;
      const dat = await tides(id), s = summary(dat); if (!s) return;
      const sn = window.TPNames ? window.TPNames.short(st.name, st.st) : { title: st.name, sub: st.st };
      const first = !el._cu; box.hidden = false; box.href = "/station/" + id; box.setAttribute("aria-label", sn.title + ": " + fmtH(s.h) + ", " + (s.rising ? "rising" : "falling") + ". Open");
      box.innerHTML = '<p class="tp-eyebrow">' + esc(why) + '</p><p class="tp-nowname"><b>' + esc(sn.title) + "</b><small>" + esc(sn.sub) + '</small></p><p class="tp-big"><b>' + esc(fmtH(s.next.h).replace(/ (ft|m)$/, "")) + "</b><span>" + unit() + '</span></p><p class="tp-next"><b>' + (s.next.k === "H" ? "High" : "Low") + " tide at " + clock(s.next.l) + "</b>, " + relIn(s.nextLeft) + '</p><p class="tp-now-row">Right now <b>' + esc(fmtH(s.h)) + '</b> <i class="tp-trend ' + (s.rising ? "up" : "dn") + '">' + (s.rising ? "&#9650; Rising" : "&#9660; Falling") + "</i></p>" + (dat.stale ? '<p class="tp-foot" style="margin:8px 0 0">Saved ' + ago(dat.at) + "</p>" : "") + spark(s); if (first) { el._cu = 1; countUp(box.querySelector(".tp-big b")); } + spark(s);
    };
    const offNote = () => { el.querySelector("#tpOff").hidden = navigator.onLine !== false; }; offNote(); addEventListener("offline", offNote); addEventListener("online", () => { offNote(); refreshHome(); }); // back online: the tides refresh by themselves
    const refreshHome = () => showNow().catch(() => {}).then(() => showSaved()).catch(() => {});
    const nearest = async (lat, lng) => {
      const all = await loadStations(), top = all.map((x) => ({ s: x, d: dist(lat, lng, x.lat, x.lng) })).sort((a, b) => a.d - b.d).filter((t) => t.s.id !== el.dataset.nowId).slice(0, 5); // the closest one is the big card above, not listed twice
      near.hidden = !top.length; // each row gets its own 24 h curve a moment later (cached for 30 minutes, three at a time)
      queueMicrotask(async () => { const rows = [...near.querySelectorAll("a")]; for (let i = 0; i < rows.length; i += 3) await Promise.all(rows.slice(i, i + 3).map(async (a) => { try { const r = summary(await tides(top[rows.indexOf(a)].s.id)); const em = a.querySelector("em"); if (r && em) em.insertAdjacentHTML("beforebegin", mini(r)); } catch { /* offline: the row stays a name and a distance */ } })); }); near.innerHTML = '<h2 class="tp-sec">Also near you</h2><div class="tp-card"><ul class="tp-list">' + top.map((t) => rowHtml(t.s, { d: t.d, next: "" })).join("") + "</ul></div>";
    };
    el.onclick = async (e) => {
      const b = e.target.closest("button"); if (!b) return;
      if (b.dataset.addplace != null) { qin.focus(); qin.scrollIntoView({ block: "center" }); return; }
      if (b.dataset.bell != null) { // tide alerts for a favorite in one tap: both highs and lows, 30 minutes early (change them on the station page)
        const sid = b.dataset.bell, N = LN(); if (!N) return; const nm = by0(sid);
        if (alarmOf(sid)) { ls.set("tp.alarm." + sid, null); await schedule(sid, nm, ls.get("tp.t." + sid, { events: [] }).events); b.setAttribute("aria-pressed", "false"); return; }
        const p = await N.requestPermissions().catch(() => null); if (p?.display !== "granted") { b.setAttribute("aria-label", "Notifications are off for this app"); return; }
        ls.set("tp.alarm." + sid, { kind: "both", lead: 30 }); await schedule(sid, nm, ls.get("tp.t." + sid, { events: [] }).events); b.setAttribute("aria-pressed", "true"); window.PrismFeel?.haptic("success"); window.PrismApp?.push?.ask({ topics: ["tide-alerts"] }).catch(() => {}); return;
      }
      if (b.dataset.rm != null) { const keep = ls.get("pw.saved", []).filter((x) => !(x.p || "").startsWith("/station/" + b.dataset.rm)); ls.set("pw.saved", keep); refreshHome(); window.PrismApp?.sync?.saved(true).catch(() => {}); return; } // one removal = one request to the account in the phone app
      if (b.dataset.install != null && deferred) { deferred.prompt(); await deferred.userChoice; deferred = null; b.hidden = true; }
      if (b.dataset.geo != null) {
        b.disabled = true; b.textContent = "Finding you..."; const msg = ask.querySelector("[data-askmsg]"), fail = (t) => { b.disabled = false; b.textContent = "Try again"; msg.textContent = t; };
        if (!navigator.geolocation) return fail("This device cannot share a location. Pick a harbor below or search for yours.");
        navigator.geolocation.getCurrentPosition((p) => { ls.set("tp.geo", [p.coords.latitude, p.coords.longitude]); showNow().catch(() => {}).then(() => nearest(p.coords.latitude, p.coords.longitude)).catch(() => {}); },
          (err) => fail(err.code === 1 ? "Location is off for this app. Allow it in the phone settings, or pick a harbor below." : "Could not find you. Try again outdoors, or pick a harbor below."), { enableHighAccuracy: false, timeout: 10000, maximumAge: 6e5 });
      }
    };
    qin.oninput = async () => {
      const v = qin.value.trim().toLowerCase(), rb = el.querySelector("#tpResBox"); if (v.length < 2) { res.innerHTML = ""; rb.hidden = true; return; } rb.hidden = false;
      const all = await loadStations(), terms = v.split(/\s+/), hits = all.filter((s) => terms.every((t) => s.key.includes(t))).slice(0, 10);
      res.innerHTML = hits.length ? hits.map((s) => rowHtml(s)).join("") : `<li><small style="padding:12px 0">No station matches "${esc(qin.value.trim())}". Try the nearest town or a harbor name.</small></li>`;
    };
    const g = ls.get("tp.geo", null);
    const heroDone = showNow().catch(() => {}); heroDone.then(() => g && nearest(g[0], g[1])).catch(() => {}); document.addEventListener("prism:refresh", refreshHome);
    heroDone.then(() => showSaved()).catch(() => {}); qin.addEventListener("focus", () => loadStations().catch(() => {}), { once: true }); // the 180 KB station list loads when it is needed, not on every home view
  }

  /* ---------- the account card (phone app only: PrismApp exists when the native shell loaded prism-mobile.js) ---------- */
  const MARK = '<svg aria-hidden="true" viewBox="0 0 32 32" width="22" height="22"><circle cx="16" cy="16" r="15" fill="#101615" stroke="#fff" stroke-opacity=".25"/><path d="M16 7l8 14H8z" fill="none" stroke="#2dd4bf" stroke-width="2" stroke-linejoin="round"/></svg>';
  function account(el) {
    const S = window.PrismApp?.session; if (!S) return;
    const box = document.createElement("div"); box.className = "tp-quiet"; box.id = "tpAccount"; el.append(box); // secondary: after the tide cards, not before them
    const draw = async (u) => {
      u = u === undefined ? await S.user() : u;
      box.className = "tp-quiet"; box.innerHTML = u ? `<span style="min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">Signed in as ${esc(u.name || u.email || "your Prism account")}</span><button class="tp-btn" data-signout>Sign out</button>`
        : `<span>Sync saved places and unlock Pro</span><button class="tp-btn" data-signin>${MARK} Continue with Prism</button>`;
    };
    box.onclick = async (e) => { const b = e.target.closest("button"); if (!b) return; b.disabled = true; if (b.dataset.signin != null) { const u = await S.signIn(); await draw(u); } else { await S.signOut(); await draw(null); } };
    S.onChange(draw); draw();
  }
  document.addEventListener("prismapp", () => document.querySelectorAll("#tp-home[data-m]:not([data-a])").forEach((el) => { el.dataset.a = "1"; account(el); }));

  /* ---------- mounting and the service worker ---------- */
  const rise = (el) => { el.classList.add("tp-in"); setTimeout(() => el.classList.remove("tp-in"), 1400); };
  function scan() {
    for (const el of document.querySelectorAll("#tp-live:not([data-m]),#tp-home:not([data-m])")) { el.dataset.m = "1"; el.classList.add("tp"); rise(el); (el.id === "tp-live" ? mountLive : mountHome)(el); if (el.id === "tp-home" && window.PrismApp) { el.dataset.a = "1"; account(el); } }
  }
  new MutationObserver(scan).observe(document.documentElement, { childList: true, subtree: true });
  scan();
  if ("serviceWorker" in navigator) addEventListener("load", () => navigator.serviceWorker.register("/sw.js").catch(() => {}));
  if (new URLSearchParams(location.search).has("tpdebug")) window.__tp = { tides, summary, heightAt, parse };
})();
