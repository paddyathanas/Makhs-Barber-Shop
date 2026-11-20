/* MAKHS BARBER SHOP — online booking
   Talks to the Google Apps Script backend (backend/Code.gs) when
   SITE_CONFIG.bookingApiUrl is set; otherwise runs in demo mode.

   Speed: the whole booking window (≈30 days) is fetched in ONE request as soon
   as the page loads, so picking a day shows its free times instantly and days
   that are fully blocked in Makis' Google Calendar (day off, holiday…) appear
   greyed out like Sunday.
   Safety: the server re-checks the calendar under a lock before every booking,
   so even a stale page can never create a wrong or double booking. */
(() => {
  const C = window.SITE_CONFIG;
  const API = (C.bookingApiUrl || "").trim();
  // When the site is shown inside a preview frame (e.g. an editor or the Claude preview), outside requests
  // to Google are blocked, so bookings run in test mode there. The live site is never framed.
  const FRAMED = (() => { try { return window.self !== window.top; } catch { return true; } })();
  const DEMO = !API || FRAMED;
  const AHEAD = C.booking.daysAhead;
  const FRESH_MS = 45 * 1000;          // availability older than this is refreshed in the background
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];

  const MONTHS = ["Ιανουάριος", "Φεβρουάριος", "Μάρτιος", "Απρίλιος", "Μάιος", "Ιούνιος", "Ιούλιος", "Αύγουστος", "Σεπτέμβριος", "Οκτώβριος", "Νοέμβριος", "Δεκέμβριος"];
  const MONTHS_GEN = ["Ιανουαρίου", "Φεβρουαρίου", "Μαρτίου", "Απριλίου", "Μαΐου", "Ιουνίου", "Ιουλίου", "Αυγούστου", "Σεπτεμβρίου", "Οκτωβρίου", "Νοεμβρίου", "Δεκεμβρίου"];
  const DAYS = ["Κυριακή", "Δευτέρα", "Τρίτη", "Τετάρτη", "Πέμπτη", "Παρασκευή", "Σάββατο"];

  const pad = n => String(n).padStart(2, "0");
  const ymd = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const parseYmd = s => { const [y, m, d] = s.split("-").map(Number); return new Date(y, m - 1, d); };
  const toMin = t => { const [h, m] = String(t).split(":").map(Number); return h * 60 + m; };
  const toTime = m => `${pad(Math.floor(m / 60))}:${pad(m % 60)}`;
  const prettyDate = d => `${DAYS[d.getDay()]} ${d.getDate()} ${MONTHS_GEN[d.getMonth()]}`;
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const phoneLink = `<a href="tel:${C.shop.phoneIntl}" class="gold">${C.shop.phone}</a>`;

  /* ---------- time in Athens (the shop's clock, whatever the visitor's timezone) ---------- */
  let fmt = null;
  try { fmt = new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/Athens", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }); } catch {}
  function athensNow() {
    const n = new Date();
    if (fmt) {
      const p = {}; fmt.formatToParts(n).forEach(x => p[x.type] = x.value);
      return { date: new Date(+p.year, +p.month - 1, +p.day), min: (+p.hour % 24) * 60 + +p.minute };
    }
    return { date: new Date(n.getFullYear(), n.getMonth(), n.getDate()), min: n.getHours() * 60 + n.getMinutes() };
  }
  const today = () => athensNow().date;
  const lastDay = () => { const d = today(); d.setDate(d.getDate() + AHEAD); return d; };

  /* ---------- state ---------- */
  const state = { service: null, date: null, time: null, step: 1, autoPick: false, dayReq: 0 };
  state.view = new Date(today().getFullYear(), today().getMonth(), 1);
  const cache = { days: {}, at: 0, loading: null, failed: false, rangeOk: true, dayLoading: {} };

  if (DEMO) {
    $("#demoNote").hidden = false;
    if (API && FRAMED) $("#demoNote").textContent = "Προεπισκόπηση: εδώ οι κρατήσεις είναι δοκιμαστικές και δεν στέλνονται στο κουρείο. Στο κανονικό site οι ώρες έρχονται από το ημερολόγιο του Μάκη.";
  }

  /* ---------- network ---------- */
  async function getJSON(url, opts = {}, timeout = 15000) {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), timeout);
    try {
      const r = await fetch(url, { ...opts, signal: ctl.signal, cache: "no-store" });
      return await r.json();
    } finally { clearTimeout(t); }
  }

  /** Busy times for the whole booking window in one request. */
  function loadRange(force) {
    if (cache.loading) return cache.loading;
    if (!force && cache.at && Date.now() - cache.at < FRESH_MS) return Promise.resolve();
    if (!cache.rangeOk) return Promise.resolve();
    renderCal();
    cache.loading = (async () => {
      const from = ymd(today()), days = AHEAD + 1;
      if (DEMO) {
        await sleep(250);
        const map = {};
        for (let i = 0; i < days; i++) { const d = today(); d.setDate(d.getDate() + i); map[ymd(d)] = []; }
        demoStore().forEach(b => { if (map[b.date]) map[b.date].push({ start: b.time, end: b.end }); });
        cache.days = map;
      } else {
        let data;
        for (let attempt = 0; ; attempt++) {
          try { data = await getJSON(`${API}?action=range&from=${from}&days=${days}`); break; }
          catch (e) { if (attempt >= 1) throw e; await sleep(700); }
        }
        if (!data.ok) throw new Error(data.error || "range");
        if (!data.days) { cache.rangeOk = false; return; }   // old backend: fall back to one day at a time
        cache.days = data.days;
      }
      cache.at = Date.now(); cache.failed = false;
    })()
      .catch(e => { console.warn("availability", e); cache.failed = true; })
      .finally(() => { cache.loading = null; onData(); });
    return cache.loading;
  }

  /** Fallback for a backend without the range action: one day per request. */
  async function loadDay(dateStr) {
    if (cache.dayLoading[dateStr]) return cache.dayLoading[dateStr];
    cache.dayLoading[dateStr] = (async () => {
      try {
        const data = await getJSON(`${API}?action=availability&date=${dateStr}`);
        if (!data.ok) throw new Error(data.error || "availability");
        cache.days[dateStr] = data.busy || [];
      } finally { delete cache.dayLoading[dateStr]; }
    })();
    return cache.dayLoading[dateStr];
  }

  /* ---------- availability logic ---------- */
  /** Free start times for a date, given busy intervals [{start,end}] */
  function daySlots(date, busy) {
    const dur = state.service ? state.service.duration : 30;
    const step = C.booking.slotStep;
    const now = athensNow();
    const minStart = +date === +now.date ? now.min + C.booking.minLeadMinutes : -1;
    const busyM = (busy || []).map(b => [toMin(b.start), toMin(b.end)]);
    const out = [];
    (C.hours[date.getDay()] || []).forEach(([a, b], ri) => {
      for (let t = toMin(a); t + dur <= toMin(b); t += step) {
        if (t < minStart) continue;
        if (busyM.some(([s, e]) => t < e && t + dur > s)) continue;
        out.push({ t: toTime(t), range: ri });
      }
    });
    return out;
  }

  /** What the calendar shows for a day: free / closed / day off / fully booked / not loaded yet. */
  function dayInfo(date) {
    if (date < today() || date > lastDay()) return { ok: false, why: "out" };
    const hours = C.hours[date.getDay()] || [];
    if (!hours.length) return { ok: false, why: "closed" };
    if (!daySlots(date, []).length) return { ok: false, why: "past" };
    const busy = cache.days[ymd(date)];
    if (!busy) return { ok: true, unknown: true };
    const slots = daySlots(date, busy);
    if (slots.length) return { ok: true, slots };
    const open = toMin(hours[0][0]), close = toMin(hours[hours.length - 1][1]);
    const off = busy.some(b => toMin(b.start) <= open && toMin(b.end) >= close);
    return { ok: false, why: off ? "off" : "full" };
  }
  const WHY = { closed: "Κλειστά", off: "Κλειστά", full: "Πλήρες", past: "Δεν υπάρχουν άλλες ώρες σήμερα", out: "" };

  function firstFreeDay() {
    for (let d = today(), end = lastDay(); d <= end; d.setDate(d.getDate() + 1)) {
      const info = dayInfo(d);
      if (info.ok && (!info.unknown || !cache.rangeOk)) return new Date(d);
    }
    return null;
  }

  /* ---------- steps ---------- */
  function go(step) {
    state.step = step;
    $$(".pane").forEach(p => p.classList.toggle("is-active", +p.dataset.pane === step));
    $$(".steps li").forEach(li => {
      const s = +li.dataset.step;
      li.classList.toggle("is-active", s === step);
      li.classList.toggle("is-done", s < step);
    });
    if (step === 2) loadRange();
    if (step === 3) renderSummary();
  }
  $$("[data-back]").forEach(b => b.addEventListener("click", () => go(state.step - 1)));
  $$(".steps li").forEach(li => li.addEventListener("click", () => { if (+li.dataset.step < state.step && state.step < 5) go(+li.dataset.step); }));

  /* ---------- step 1: services ---------- */
  $("#svcPick").innerHTML = C.services.map(s => `
    <button type="button" class="svc-opt" data-id="${s.id}">
      <b>${s.name}</b><small><span>◷ ${s.duration}′</span><em>${s.price}€</em></small>
    </button>`).join("");
  function selectService(id) {
    const s = C.services.find(x => x.id === id); if (!s) return;
    state.service = s; state.time = null;
    $$(".svc-opt").forEach(b => b.classList.toggle("is-selected", b.dataset.id === id));
    // keep the chosen day if it still fits this service, otherwise jump to the first free day
    if (state.date && !(dayInfo(state.date).ok)) state.date = null;
    if (!state.date) { state.autoPick = true; state.date = firstFreeDay(); }
    if (state.date) state.autoPick = false;
    go(2);
    renderCal(); renderSlots();
  }
  $$(".svc-opt").forEach(b => b.addEventListener("click", () => selectService(b.dataset.id)));
  window.MakhsBooking = { selectService };

  /* ---------- step 2: calendar ---------- */
  function renderCal() {
    const v = state.view, y = v.getFullYear(), m = v.getMonth();
    const t = today(), end = lastDay();
    $("#calTitle").textContent = `${MONTHS[m]} ${y}`;
    $("#calPrev").disabled = y === t.getFullYear() && m === t.getMonth();
    $("#calNext").disabled = new Date(y, m + 1, 1) > end;
    const offset = (new Date(y, m, 1).getDay() + 6) % 7; // Monday first
    const days = new Date(y, m + 1, 0).getDate();
    let html = "";
    for (let i = 0; i < offset; i++) html += `<span class="day day--blank"></span>`;
    for (let d = 1; d <= days; d++) {
      const date = new Date(y, m, d), info = dayInfo(date);
      const cls = ["day",
        +date === +t ? "is-today" : "",
        state.date && +date === +state.date ? "is-selected" : "",
        info.unknown ? "is-unknown" : "",
        !info.ok && info.why !== "out" ? "is-" + info.why : ""].join(" ").replace(/\s+/g, " ").trim();
      const label = `${prettyDate(date)}${WHY[info.why] ? " · " + WHY[info.why] : ""}`;
      html += `<button type="button" class="${cls}" data-date="${ymd(date)}" aria-label="${label}" ${info.why && WHY[info.why] ? `title="${WHY[info.why]}"` : ""} ${info.ok ? "" : "disabled"}>${d}</button>`;
    }
    const grid = $("#calGrid");
    grid.innerHTML = html;
    grid.classList.toggle("is-loading", !!cache.loading && !cache.at);
  }
  $("#calGrid").addEventListener("click", e => {
    const b = e.target.closest(".day:not(:disabled)"); if (!b) return;
    state.date = parseYmd(b.dataset.date); state.time = null; state.autoPick = false;
    renderCal(); renderSlots();
    // on phones the times are below the calendar: bring them into view
    if (matchMedia("(max-width: 760px)").matches) {
      const box = $(".slots"), r = box.getBoundingClientRect();
      if (r.top > innerHeight * 0.55) scrollBy({ top: r.top - innerHeight * 0.3, behavior: "smooth" });
    }
  });
  $("#calPrev").addEventListener("click", () => { state.view.setMonth(state.view.getMonth() - 1); renderCal(); });
  $("#calNext").addEventListener("click", () => { state.view.setMonth(state.view.getMonth() + 1); renderCal(); });

  /* ---------- step 2: times ---------- */
  const grid = $("#slotsGrid");
  const skeleton = () => { grid.innerHTML = Array(8).fill('<div class="skeleton"></div>').join(""); };

  function renderSlots() {
    if (!state.date) {
      $("#slotsTitle").textContent = "Διάλεξε ημέρα";
      if (state.autoPick && cache.rangeOk) {
        if (cache.loading || (!cache.at && !cache.failed)) { $("#slotsTitle").textContent = "Φορτώνουν οι διαθέσιμες ώρες…"; skeleton(); return; }
        if (!cache.at) return showError();
        $("#slotsTitle").textContent = "Δεν υπάρχουν διαθέσιμες ημέρες";
        grid.innerHTML = `<p class="muted small">Κάλεσε στο ${phoneLink} για να βρούμε ώρα.</p>`;
        return;
      }
      grid.innerHTML = `<p class="muted small">Οι διαθέσιμες ώρες θα εμφανιστούν εδώ.</p>`;
      return;
    }
    if (state.date.getMonth() !== state.view.getMonth() || state.date.getFullYear() !== state.view.getFullYear()) {
      state.view = new Date(state.date.getFullYear(), state.date.getMonth(), 1); renderCal();
    }
    $("#slotsTitle").textContent = prettyDate(state.date);
    const key = ymd(state.date);
    const busy = cache.days[key];

    if (!busy) {
      if (cache.loading) { skeleton(); return; }                  // onData() re-renders when the range arrives
      if (cache.rangeOk && !cache.failed) { skeleton(); loadRange(); return; }
      if (DEMO || cache.failed && cache.rangeOk) return showError();
      // old backend: fetch this single day
      skeleton();
      const id = ++state.dayReq;
      loadDay(key).then(() => { if (id === state.dayReq) { renderCal(); renderSlots(); } })
        .catch(() => { if (id === state.dayReq) showError(); });
      return;
    }

    const info = dayInfo(state.date);
    if (!info.ok) {
      const msg = info.why === "off" ? "Το κουρείο είναι κλειστό αυτή τη μέρα." : info.why === "full" ? "Δεν έμειναν ελεύθερες ώρες αυτή τη μέρα." : "Δεν υπάρχουν ελεύθερες ώρες αυτή τη μέρα.";
      grid.innerHTML = `<p class="muted small">${msg} Διάλεξε άλλη ημέρα.</p>`;
      return;
    }
    const ranges = C.hours[state.date.getDay()];
    if (state.time && !info.slots.some(s => s.t === state.time)) state.time = null;
    let html = "", lastRange = -1;
    info.slots.forEach(s => {
      if (ranges.length > 1 && s.range !== lastRange) { html += `<span class="slots__label">${s.range === 0 ? "Πρωί" : "Απόγευμα"}</span>`; lastRange = s.range; }
      html += `<button type="button" class="slot${s.t === state.time ? " is-selected" : ""}" data-time="${s.t}">${s.t}</button>`;
    });
    grid.innerHTML = html;
  }
  grid.addEventListener("click", e => {
    const b = e.target.closest(".slot"); if (!b) return;
    state.time = b.dataset.time;
    $$(".slot", grid).forEach(x => x.classList.toggle("is-selected", x === b));
    setTimeout(() => go(3), 180);
  });

  function showError() {
    grid.innerHTML = `<p class="muted small">Δεν ήταν δυνατή η φόρτωση των διαθέσιμων ωρών. <button type="button" class="link-btn gold" id="retryAvail">Δοκίμασε ξανά</button> ή κάλεσε στο ${phoneLink}.</p>`;
    $("#retryAvail").addEventListener("click", () => { cache.failed = false; skeleton(); loadRange(true); });
  }

  /** Called whenever fresh availability arrives. */
  function onData() {
    if (state.autoPick && !state.date && (cache.at || !cache.rangeOk)) { state.date = firstFreeDay(); if (state.date) state.autoPick = false; }
    renderCal();
    if (state.step === 2) renderSlots();
    if ((state.step === 3 || state.step === 4) && state.date && state.time) {
      const info = dayInfo(state.date);
      if (!info.ok || !info.slots || !info.slots.some(s => s.t === state.time)) {
        err.textContent = "Η ώρα που διάλεξες μόλις έκλεισε. Διάλεξε άλλη.";
        state.time = null;
        setTimeout(() => { err.textContent = ""; go(2); renderSlots(); }, 1800);
      }
    }
  }

  /* prefetch: start loading as soon as the page is idle, refresh while the visitor is choosing */
  const idle = window.requestIdleCallback || (f => setTimeout(f, 1200));
  idle(() => loadRange(), { timeout: 2500 });
  const bookingEl = $("#booking");
  if (bookingEl && "IntersectionObserver" in window) {
    new IntersectionObserver((en, o) => { if (en[0].isIntersecting) { loadRange(); o.disconnect(); } }, { rootMargin: "800px 0px" }).observe(bookingEl);
  }
  document.addEventListener("visibilitychange", () => { if (!document.hidden && state.step >= 2 && state.step < 5) loadRange(); });
  setInterval(() => { if (!document.hidden && state.step >= 2 && state.step <= 4) loadRange(); }, 60 * 1000);

  /* ---------- step 3: details ---------- */
  const form = $("#bookingForm"), err = $("#formError"), btn = $("#submitBtn");
  const SAVED = "makhs-customer";
  try {
    const saved = JSON.parse(localStorage.getItem(SAVED) || "null");
    if (saved) ["name", "phone", "email"].forEach(k => { if (saved[k] && form.elements[k]) form.elements[k].value = saved[k]; });
  } catch {}

  function renderSummary() {
    const s = state.service;
    const end = toTime(toMin(state.time) + s.duration);
    $("#summary").innerHTML = `
      <div><small>Υπηρεσία</small><b>${s.name}</b></div>
      <div><small>Ημέρα</small><b>${prettyDate(state.date)}</b></div>
      <div><small>Ώρα</small><b>${state.time}–${end}</b></div>
      <div><small>Τιμή</small><b class="gold">${s.price}€</b></div>`;
    const first = ["fName", "fPhone", "fEmail"].map(id => $("#" + id)).find(el => !el.value.trim()) || btn;
    if (matchMedia("(hover: hover)").matches) setTimeout(() => first.focus({ preventScroll: true }), 300);
  }

  const rid = () => (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2));

  /* Step 3 → 4: check the details and show the email exactly as it will be sent */
  let pending = null;
  form.addEventListener("submit", e => {
    e.preventDefault();
    err.textContent = "";
    $$(".field", form).forEach(f => f.classList.remove("is-invalid"));
    if (!state.service || !state.date || !state.time) { go(state.service ? 2 : 1); return; }
    const v = Object.fromEntries(new FormData(form));
    const bad = [];
    if ((v.name || "").trim().length < 3) bad.push("fName");
    if (!/^[+\d][\d\s-]{8,}$/.test((v.phone || "").trim())) bad.push("fPhone");
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test((v.email || "").trim())) bad.push("fEmail");
    if (bad.length) {
      bad.forEach(id => $("#" + id).parentElement.classList.add("is-invalid"));
      $("#" + bad[0]).focus();
      err.textContent = "Συμπλήρωσε σωστά όνομα, κινητό και email.";
      return;
    }
    pending = {
      action: "book",
      rid: rid(),                  // same id on a retry → the server never books twice
      service: state.service.id,
      date: ymd(state.date),
      time: state.time,
      name: v.name.trim(), phone: v.phone.trim(), email: v.email.trim(), notes: (v.notes || "").trim(),
      website: v.website || "" // honeypot
    };
    renderDraft(pending);
    go(4);
    $("#bookingApp").scrollIntoView({ behavior: "smooth", block: "start" });
  });

  const esc = t => String(t).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  /** Same content as the confirmation email the server sends (backend/Code.gs → emailCustomer). */
  function renderDraft(p) {
    const s = state.service, end = toTime(toMin(p.time) + s.duration), day = prettyDate(state.date);
    $("#draftTo").textContent = p.email;
    $("#draftSubject").textContent = `Επιβεβαίωση ραντεβού · ${day} στις ${p.time}`;
    $("#draftBody").innerHTML = `
      <p class="draft__hello">Γεια σου ${esc(p.name.split(" ")[0])}, σε περιμένουμε!</p>
      <table class="draft__table">
        <tr><th>Υπηρεσία</th><td>${esc(s.name)}</td></tr>
        <tr><th>Ημέρα</th><td>${day}</td></tr>
        <tr><th>Ώρα</th><td>${p.time}–${end}</td></tr>
        <tr><th>Τιμή</th><td>${s.price}€</td></tr>
        <tr><th>Όνομα</th><td>${esc(p.name)}</td></tr>
        <tr><th>Κινητό</th><td>${esc(p.phone)}</td></tr>
        ${p.notes ? `<tr><th>Σημείωση</th><td>${esc(p.notes)}</td></tr>` : ""}
      </table>
      <p class="draft__shop">${esc(C.shop.address)}<br>${esc(C.shop.phone)}</p>
      <p class="draft__foot">Θα πάρεις και αρχείο για το ημερολόγιό σου, καθώς και link για ακύρωση αν δεν μπορείς να έρθεις.</p>`;
  }

  /* Step 4: «Αποστολή email» books the slot; the server sends the emails and adds it to Google Calendar */
  const sendBtn = $("#sendBtn"), sendErr = $("#sendError");
  sendBtn.addEventListener("click", async () => {
    if (sendBtn.disabled || !pending) return;
    sendErr.textContent = "";
    const payload = pending;
    sendBtn.disabled = true; sendBtn.textContent = "Αποστολή…";
    try {
      let result;
      if (DEMO) { await sleep(600); result = demoBook(payload); }
      else {
        const send = () => getJSON(API, {
          method: "POST",
          headers: { "Content-Type": "text/plain;charset=utf-8" }, // avoids CORS preflight with Apps Script
          body: JSON.stringify(payload)
        }, 30000);
        try { result = await send(); }
        catch { await sleep(1200); result = await send(); }   // safe to repeat thanks to rid
      }
      if (!result.ok) {
        if (["slot_taken", "too_soon", "closed"].includes(result.error)) {
          sendErr.textContent = result.error === "slot_taken"
            ? "Αυτή η ώρα μόλις κλείστηκε. Διάλεξε άλλη ώρα."
            : (result.message || "Η ώρα αυτή δεν είναι πλέον διαθέσιμη.") + " Διάλεξε άλλη ώρα.";
          state.time = null; pending = null;
          loadRange(true);
          setTimeout(() => { sendErr.textContent = ""; go(2); renderSlots(); }, 1800);
        } else sendErr.textContent = result.message || `Κάτι πήγε στραβά. Δοκίμασε ξανά ή κάλεσε στο ${C.shop.phone}.`;
        return;
      }
      try { localStorage.setItem(SAVED, JSON.stringify({ name: payload.name, phone: payload.phone, email: payload.email })); } catch {}
      // mark the slot as taken right away (the next refresh confirms it)
      (cache.days[payload.date] = cache.days[payload.date] || []).push({ start: payload.time, end: toTime(toMin(payload.time) + state.service.duration) });
      pending = null;
      done(payload, result.id, result.mail !== false);
    } catch (ex) {
      sendErr.innerHTML = `Δεν ήταν δυνατή η σύνδεση. Δοκίμασε ξανά ή κάλεσε στο ${phoneLink}.`;
    } finally {
      sendBtn.disabled = false; sendBtn.textContent = "Αποστολή email";
    }
  });

  function done(p, id, mailed) {
    const s = state.service, end = toTime(toMin(p.time) + s.duration);
    const when = `<b>${s.name}</b>, ${prettyDate(state.date)} στις <b>${p.time}</b>`;
    $("#doneText").innerHTML = DEMO
      ? `${when}.<br>Προεπισκόπηση: εδώ δεν στέλνεται email. Στο κανονικό site το email πηγαίνει στο <b>${esc(p.email)}</b> και το ραντεβού μπαίνει στο ημερολόγιο του κουρείου.`
      : mailed
        ? `${when}.<br>Το email επιβεβαίωσης στάλθηκε στο <b>${esc(p.email)}</b>${id ? ` (κωδικός ${id})` : ""}. Τα λέμε σύντομα!`
        : `${when}${id ? ` (κωδικός <b>${id}</b>)` : ""}.<br>Το ραντεβού σου είναι καταχωρημένο, αλλά αυτή τη φορά δεν μπορέσαμε να στείλουμε email. Πρόσθεσέ το στο ημερολόγιό σου με το κουμπί παρακάτω. Για οτιδήποτε κάλεσε στο ${phoneLink}.`;
    const dt = t => p.date.replace(/-/g, "") + "T" + t.replace(":", "") + "00";
    $("#gcalLink").href = "https://calendar.google.com/calendar/render?action=TEMPLATE"
      + `&text=${encodeURIComponent(`${s.name} · ${C.shop.fullName}`)}`
      + `&dates=${dt(p.time)}/${dt(end)}&ctz=Europe/Athens`
      + `&location=${encodeURIComponent(C.shop.address)}`
      + `&details=${encodeURIComponent(`Τηλ. ${C.shop.phone}`)}`;
    $("#fNotes").value = "";
    go(5);
    $("#bookingApp").scrollIntoView({ behavior: "smooth", block: "start" });
  }
  $("#editBtn").addEventListener("click", () => go(3));
  $("#newBooking").addEventListener("click", () => {
    state.service = null; state.time = null; state.date = null; pending = null;
    $$(".svc-opt").forEach(b => b.classList.remove("is-selected"));
    go(1);
  });

  /* ---------- demo store ---------- */
  function demoStore() { try { return JSON.parse(localStorage.getItem("makhs-demo-bookings") || "[]"); } catch { return []; } }
  function demoBook(p) {
    const s = C.services.find(x => x.id === p.service);
    const end = toTime(toMin(p.time) + s.duration);
    const list = demoStore();
    if (list.some(b => b.date === p.date && toMin(p.time) < toMin(b.end) && toMin(end) > toMin(b.time))) return { ok: false, error: "slot_taken" };
    list.push({ date: p.date, time: p.time, end });
    try { localStorage.setItem("makhs-demo-bookings", JSON.stringify(list)); } catch {}
    return { ok: true, id: "DEMO" };
  }

  renderCal();
})();
