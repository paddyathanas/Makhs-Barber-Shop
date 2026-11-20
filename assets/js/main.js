/* Makhs Barber Shop: splash, menu, prices, hours, gallery */
(() => {
  const C = window.SITE_CONFIG;
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;

  /* Splash (home page only). Skipped when the visitor arrives at a section, e.g. index.html#booking */
  const splash = $("#splash");
  if (splash) {
    let done = false;
    const CUT_MS = 450, OPEN_MS = 800;
    const reveal = () => document.body.classList.remove("is-loading");
    const finish = () => { reveal(); splash.classList.add("is-gone"); };
    const open = () => {
      if (done) return; done = true;
      if (reduced) return finish();
      // cut exactly through the middle of the letters
      const w = $(".splash__word", splash).getBoundingClientRect();
      if (w.height) splash.style.setProperty("--cut", `${((w.top + w.height * 0.52) / splash.offsetHeight * 100).toFixed(2)}%`);
      splash.classList.add("is-cutting");
      setTimeout(() => {
        // each half takes its own copy of the logo, so the logo leaves with the screen
        const content = $(".splash__content", splash), h = splash.offsetHeight;
        ["top", "bottom"].forEach(side => {
          const ghost = document.createElement("div");
          ghost.className = `splash__ghost splash__ghost--${side}`;
          ghost.style.height = h + "px";
          const copy = content.cloneNode(true);
          copy.classList.add("splash__content--ghost");
          ghost.appendChild(copy);
          $(`.splash__half--${side}`, splash).appendChild(ghost);
        });
        splash.classList.add("is-open");
        reveal();
      }, CUT_MS);
      setTimeout(() => splash.classList.add("is-gone"), CUT_MS + OPEN_MS + 50);
    };
    let skip = false;
    try { skip = sessionStorage.getItem("makhs-nosplash") === "1"; sessionStorage.removeItem("makhs-nosplash"); } catch {}
    if (skip) { done = true; finish(); }
    else {
      const seen = (() => { try { return sessionStorage.getItem("makhs-splash"); } catch { return null; } })();
      try { sessionStorage.setItem("makhs-splash", "1"); } catch {}
      const delay = reduced ? 0 : (seen ? 450 : 1250);
      const heroImg = $(".hero__photo img");
      Promise.all([
        document.fonts ? document.fonts.ready : Promise.resolve(),
        heroImg && !heroImg.complete ? new Promise(r => { heroImg.onload = heroImg.onerror = r; }) : Promise.resolve()
      ]).then(() => setTimeout(open, delay));
      setTimeout(open, 3500); // safety net on slow connections
      splash.addEventListener("click", open);
    }
  }

  /* Every page opens at the top, unless the link points to a section (e.g. index.html#booking) */
  if ("scrollRestoration" in history) history.scrollRestoration = "manual";
  const hashTarget = () => location.hash.length > 1 && document.getElementById(decodeURIComponent(location.hash.slice(1)));
  const toTop = () => { if (!hashTarget()) scrollTo(0, 0); };
  toTop();
  addEventListener("pageshow", toTop);

  /* Mobile menu */
  const header = $("#header"), burger = $("#burger");
  const setMenu = open => {
    header.classList.toggle("is-open", open);
    burger.setAttribute("aria-expanded", open);
    document.body.style.overflow = open ? "hidden" : "";
  };
  burger.addEventListener("click", () => setMenu(!header.classList.contains("is-open")));
  $$("#menu a").forEach(a => a.addEventListener("click", () => setMenu(false)));
  addEventListener("keydown", e => { if (e.key === "Escape") setMenu(false); });

  /* Header border once the page scrolls */
  const onScroll = () => header.classList.toggle("is-scrolled", scrollY > 8);
  addEventListener("scroll", onScroll, { passive: true });
  onScroll();

  /* A click from another page to a section of the home page (e.g. "Κλείσε ραντεβού") lands there without the splash */
  document.addEventListener("click", e => {
    const a = e.target.closest("a[href]");
    if (!a || a.target === "_blank") return;
    const url = new URL(a.href, location.href);
    const toHome = url.origin === location.origin && /(\/|index\.html)$/.test(url.pathname);
    if (toHome && url.hash.length > 1 && url.pathname !== location.pathname) {
      try { sessionStorage.setItem("makhs-nosplash", "1"); } catch {}
    }
  }, true);

  /* A link to the page you are already on (e.g. "Κριτικές" while reading the reviews) glides to the top instead of reloading */
  document.addEventListener("click", e => {
    const a = e.target.closest("a[href]");
    if (!a || a.target === "_blank" || e.metaKey || e.ctrlKey || e.shiftKey) return;
    const url = new URL(a.href, location.href);
    if (url.origin !== location.origin || url.pathname !== location.pathname) return;
    if (url.hash && url.hash !== "#top") return;               // section links scroll to their section
    e.preventDefault();
    setMenu(false);
    scrollTo({ top: 0, behavior: reduced ? "auto" : "smooth" });
  });

  /* Smooth page changes. Modern browsers use cross-document view transitions (CSS);
     the rest get a short fade-out here and a fade-in from CSS. */
  const root = document.documentElement;
  if (root.classList.contains("fade-nav") && !reduced) {
    document.addEventListener("click", e => {
      const a = e.target.closest("a[href]");
      if (!a || e.defaultPrevented || e.button || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || a.target === "_blank") return;
      const url = new URL(a.href, location.href);
      if (url.origin !== location.origin || !/^https?:$/.test(url.protocol)) return;
      if (url.pathname === location.pathname) return;          // same page: handled below
      e.preventDefault();
      setMenu(false);
      root.classList.add("is-leaving");
      setTimeout(() => { location.href = url.href; }, 200);
    });
    addEventListener("pageshow", () => root.classList.remove("is-leaving"));
  }

  /* Arriving from another page at a section (e.g. index.html#booking): glide to it instead of jumping */
  if (location.hash.length > 1 && !reduced && !splash) {
    const target = document.getElementById(decodeURIComponent(location.hash.slice(1)));
    if (target) {
      if ("scrollRestoration" in history) history.scrollRestoration = "manual";
      scrollTo(0, 0);
      requestAnimationFrame(() => setTimeout(() => target.scrollIntoView({ behavior: "smooth" }), 120));
    }
  }

  /* Price list from config */
  const priceList = $("#priceList");
  if (priceList) priceList.innerHTML = C.services.map(s => `
    <li class="price">
      <div class="price__main">
        <h3>${s.name}</h3>
        <p>${s.desc}</p>
      </div>
      <span class="price__dur">${s.duration} λεπτά</span>
      <span class="price__eur">${s.price} €</span>
      <button class="btn btn--outline btn--sm" type="button" data-book="${s.id}" aria-label="Κλείσε ραντεβού για ${s.name}">Κλείσε</button>
    </li>`).join("");
  $$("[data-book]").forEach(b => b.addEventListener("click", () => {
    window.MakhsBooking && window.MakhsBooking.selectService(b.dataset.book);
    $("#booking").scrollIntoView({ behavior: "smooth" });
  }));

  /* Hours table and "open now" */
  const days = ["Κυριακή", "Δευτέρα", "Τρίτη", "Τετάρτη", "Πέμπτη", "Παρασκευή", "Σάββατο"];
  const now = new Date(), today = now.getDay();
  const fmtRanges = r => r.length ? r.map(([a, b]) => `${a}–${b}`).join(", ") : "Κλειστά";
  const hoursTable = $("#hoursTable");
  if (hoursTable) hoursTable.innerHTML = [1, 2, 3, 4, 5, 6, 0].map(d =>
    `<tr${d === today ? ' class="is-today"' : ""}><th scope="row">${days[d]}</th><td>${fmtRanges(C.hours[d])}</td></tr>`
  ).join("");

  const mins = t => { const [h, m] = t.split(":").map(Number); return h * 60 + m; };
  const nowM = now.getHours() * 60 + now.getMinutes();
  const open = (C.hours[today] || []).find(([a, b]) => nowM >= mins(a) && nowM < mins(b));
  let text, cls;
  if (open) { text = `Ανοιχτά τώρα, μέχρι τις ${open[1]}`; cls = "is-open"; }
  else {
    let next = null;
    for (let i = 0; i < 8 && !next; i++) {
      const d = (today + i) % 7;
      const r = (C.hours[d] || []).find(([a]) => i > 0 || mins(a) > nowM);
      if (r) next = { d, i, t: r[0] };
    }
    const when = !next ? "" : next.i === 0 ? `σήμερα στις ${next.t}` : next.i === 1 ? `αύριο στις ${next.t}` : `${days[next.d]} στις ${next.t}`;
    text = next ? `Κλειστά τώρα. Ανοίγει ${when}` : "Κλειστά";
    cls = "is-closed";
  }
  ["#heroStatus", "#openNow"].forEach(id => { const el = $(id); if (!el) return; el.textContent = text; el.classList.add(cls); });

  $("#year").textContent = now.getFullYear();
  if (C.shop.facebook && $("#fbLink")) { $("#fbLink").href = C.shop.facebook; $("#fbWrap").hidden = false; }

  /* Lightbox */
  const lb = $("#lightbox");
  if (!lb) return;
  const lbImg = $("img", lb), imgs = $$("#gallery img");
  let idx = 0, lastFocus = null;
  const show = i => { idx = (i + imgs.length) % imgs.length; lbImg.src = imgs[idx].src; lbImg.alt = imgs[idx].alt; };
  const close = () => { lb.hidden = true; document.body.style.overflow = ""; lastFocus && lastFocus.focus(); };
  imgs.forEach((img, i) => {
    const fig = img.parentElement;
    fig.tabIndex = 0;
    fig.setAttribute("role", "button");
    fig.setAttribute("aria-label", `Μεγέθυνση: ${img.alt}`);
    const openLb = () => { lastFocus = fig; show(i); lb.hidden = false; document.body.style.overflow = "hidden"; $(".lightbox__close").focus(); };
    fig.addEventListener("click", openLb);
    fig.addEventListener("keydown", e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); openLb(); } });
  });
  $(".lightbox__close").addEventListener("click", close);
  $(".lightbox__prev").addEventListener("click", e => { e.stopPropagation(); show(idx - 1); });
  $(".lightbox__next").addEventListener("click", e => { e.stopPropagation(); show(idx + 1); });
  lb.addEventListener("click", e => { if (e.target === lb) close(); });
  addEventListener("keydown", e => {
    if (lb.hidden) return;
    if (e.key === "Escape") close();
    if (e.key === "ArrowLeft") show(idx - 1);
    if (e.key === "ArrowRight") show(idx + 1);
  });
})();
