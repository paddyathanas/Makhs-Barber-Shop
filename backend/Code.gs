/**
 * MAKHS BARBER SHOP — booking backend (Google Apps Script)
 * ---------------------------------------------------------
 * Free, runs on the shop owner's Google account:
 *   • stores every booking in a Google Sheet
 *   • blocks double bookings (with a lock)
 *   • emails the CUSTOMER a confirmation (+ .ics calendar file + cancel link)
 *   • emails the OWNER a notification (with call / WhatsApp links)
 *   • optionally adds the appointment to the owner's Google Calendar
 *
 * Setup: see README.md → «Ενεργοποίηση κρατήσεων».
 */

/* ======================= CONFIG ======================= */
const CONFIG = {
  /* Email που λαμβάνει τις κρατήσεις.
     Κενό = ο λογαριασμός Google που κάνει το Deploy (δηλ. όποιος το εγκαταστήσει).
     Έτσι δεν χρειάζεται να γραφτεί email μέσα στον κώδικα (το repo είναι δημόσιο). */
  OWNER_EMAIL: "",
  SHOP_NAME: "Makhs Barber Shop",
  SHOP_ADDRESS: "Παπάγου 92, Ζωγράφου 157 72",
  SHOP_PHONE: "210 775 9949",
  /* Google Calendar = η «αλήθεια» για τις ελεύθερες ώρες.
     true  → κάθε γεγονός στο ημερολόγιο του Μάκη (ραντεβού από τηλέφωνο, «Κλειστά», άδεια…)
             μπλοκάρει αυτή την ώρα στο site. Οι online κρατήσεις μπαίνουν κι αυτές στο ημερολόγιο.
             Αν ο Μάκης σβήσει ένα γεγονός, η ώρα ελευθερώνεται.
     false → οι ελεύθερες ώρες βγαίνουν μόνο από το Google Sheet (χωρίς ημερολόγιο). */
  USE_CALENDAR: true,
  CALENDAR_ID: "",                           // κενό = κύριο ημερολόγιο. Ή ID ξεχωριστού ημερολογίου π.χ. «Κουρείο»
  DAYS_AHEAD: 30,
  MIN_LEAD_MINUTES: 60,
  SHEET_NAME: "Κρατήσεις",
  /* Για ταχύτητα, οι ελεύθερες ώρες κρατιούνται λίγα δευτερόλεπτα σε cache.
     ΔΕΝ επηρεάζει την ασφάλεια: πριν από κάθε κράτηση ο server ξαναδιαβάζει το ημερολόγιο. */
  RANGE_CACHE_SECONDS: 20,

  // id → [όνομα, λεπτά, τιμή]   (ίδια με assets/js/config.js)
  SERVICES: {
    haircut: ["Ανδρικό κούρεμα", 30, 11],
    fade:    ["Skin fade / σχέδια", 40, 13],
    combo:   ["Κούρεμα & γένια", 50, 16],
    beard:   ["Περιποίηση γενειάδας", 20, 7],
    shave:   ["Ξύρισμα με ζεστή πετσέτα", 30, 9],
    kids:    ["Παιδικό κούρεμα", 30, 10]
  },

  // 0 = Κυριακή … 6 = Σάββατο  (ίδιο με assets/js/config.js)
  HOURS: {
    0: [],
    1: [],                                   // Δευτέρα: κλειστά
    2: [["09:00", "14:00"], ["17:00", "21:00"]],
    3: [["09:00", "15:00"]],
    4: [["09:00", "14:00"], ["17:00", "21:00"]],
    5: [["09:00", "14:00"], ["17:00", "21:00"]],
    6: [["09:00", "15:00"]]
  }
};

const HEADERS = ["ID", "Δημιουργία", "Ημερομηνία", "Ώρα", "Λήξη", "Υπηρεσία", "Όνομα", "Τηλέφωνο", "Email", "Σημείωση", "Κατάσταση", "Token"];
const DAYS = ["Κυριακή", "Δευτέρα", "Τρίτη", "Τετάρτη", "Πέμπτη", "Παρασκευή", "Σάββατο"];
const MONTHS_GEN = ["Ιανουαρίου", "Φεβρουαρίου", "Μαρτίου", "Απριλίου", "Μαΐου", "Ιουνίου", "Ιουλίου", "Αυγούστου", "Σεπτεμβρίου", "Οκτωβρίου", "Νοεμβρίου", "Δεκεμβρίου"];

/* ======================= HTTP ======================= */
const VERSION = 4;

function doGet(e) {
  const p = (e && e.parameter) || {};
  try {
    if (p.action === "availability") return json({ ok: true, date: p.date, busy: busyFor(p.date) });
    // One call for many days (the site prefetches the whole booking window → instant day switching)
    if (p.action === "range") {
      const days = Math.min(Math.max(parseInt(p.days, 10) || 1, 1), CONFIG.DAYS_AHEAD + 2);
      const key = "range:" + gen() + ":" + p.from + ":" + days;
      const cache = CacheService.getScriptCache();
      const hit = cache.get(key);
      if (hit) return text(hit);
      const body = JSON.stringify({ ok: true, v: VERSION, from: p.from, days: busyRange(p.from, days) });
      try { cache.put(key, body, CONFIG.RANGE_CACHE_SECONDS); } catch (err) { /* too big for cache: fine */ }
      return text(body);
    }
    if (p.action === "cancel") return cancelPage(p.id, p.token, p.confirm === "yes");
    return json({ ok: true, v: VERSION, service: CONFIG.SHOP_NAME });
  } catch (err) {
    return json({ ok: false, error: "server", message: String(err) });
  }
}

function doPost(e) {
  let data;
  try { data = JSON.parse(e.postData.contents); } catch (err) { return json({ ok: false, error: "bad_json" }); }
  if (data.website) return json({ ok: true, id: "OK" }); // honeypot → silently ignore bots
  if (data.action !== "book") return json({ ok: false, error: "bad_action" });

  const v = validate(data);
  if (v.error) return json({ ok: false, error: v.error, message: v.message });

  const cache = CacheService.getScriptCache();
  const rid = /^[\w-]{8,64}$/.test(String(data.rid || "")) ? "rid:" + data.rid : null;

  const lock = LockService.getScriptLock();
  if (!lock.tryLock(20000)) return json({ ok: false, error: "busy", message: "Δοκίμασε ξανά σε λίγα δευτερόλεπτα." });
  let booking;
  try {
    // Same request sent twice (e.g. the phone lost signal and the site retried) → answer as before, don't book twice.
    const prev = rid && cache.get(rid);
    if (prev) return json({ ok: true, id: prev, repeat: true });

    // Fresh read of the calendar/sheet (never the cache) + the last few minutes of online bookings.
    const overlap = busyFor(v.date).some(b => toMin(v.time) < toMin(b.end) && toMin(v.end) > toMin(b.start));
    if (overlap) return json({ ok: false, error: "slot_taken" });
    booking = {
      id: Utilities.getUuid().slice(0, 8).toUpperCase(),
      token: Utilities.getUuid().replace(/-/g, ""),
      created: new Date(),
      date: v.date, time: v.time, end: v.end,
      serviceId: v.serviceId, serviceName: v.service[0], price: v.service[2],
      name: v.name, phone: v.phone, email: v.email, notes: v.notes
    };
    // In calendar mode the event IS the reservation, so create it inside the lock.
    if (CONFIG.USE_CALENDAR) {
      try { addToCalendar(booking); }
      catch (err) { console.error(err); return json({ ok: false, error: "server", message: "Δεν ήταν δυνατή η κράτηση. Κάλεσε στο " + CONFIG.SHOP_PHONE + "." }); }
    }
    try {
      const sh = sheet();
      sh.appendRow([booking.id, booking.created, booking.date, booking.time, booking.end, booking.serviceName,
        booking.name, "'" + booking.phone, booking.email, booking.notes, "Ενεργό", booking.token]);
      booking.row = sh.getLastRow();
      SpreadsheetApp.flush();
    } catch (err) {
      console.error(err);
      // Without the calendar the sheet IS the reservation → must not report success.
      if (!CONFIG.USE_CALENDAR) return json({ ok: false, error: "server", message: "Δεν ήταν δυνατή η κράτηση. Κάλεσε στο " + CONFIG.SHOP_PHONE + "." });
    }
    rememberRecent(booking);
    if (rid) cache.put(rid, booking.id, 21600);
    bumpGen();
  } finally {
    lock.releaseLock();
  }

  // Emails go out after the lock. A failure never cancels the booking, but it is
  // written in the sheet (column «Email») so it can never go unnoticed again.
  const mailCustomer = emailCustomer(booking);
  const mailOwner = emailOwner(booking);
  logMail(booking, mailCustomer, mailOwner);
  return json({ ok: true, id: booking.id, mail: mailCustomer === "OK", mailOwner: mailOwner === "OK" });
}

/* ======================= LOGIC ======================= */
function validate(d) {
  const service = CONFIG.SERVICES[d.service];
  if (!service) return { error: "bad_service", message: "Άγνωστη υπηρεσία." };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d.date || "") || !/^\d{2}:\d{2}$/.test(d.time || "")) return { error: "bad_datetime", message: "Μη έγκυρη ημερομηνία/ώρα." };
  const name = String(d.name || "").trim().slice(0, 80);
  const phone = String(d.phone || "").trim().slice(0, 30);
  const email = String(d.email || "").trim().slice(0, 120);
  const notes = String(d.notes || "").trim().slice(0, 400);
  if (name.length < 3) return { error: "bad_name", message: "Συμπλήρωσε ονοματεπώνυμο." };
  if (!/^[+\d][\d\s-]{8,}$/.test(phone)) return { error: "bad_phone", message: "Μη έγκυρο τηλέφωνο." };
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) return { error: "bad_email", message: "Μη έγκυρο email." };

  const start = dateAt(d.date, d.time);
  const now = new Date();
  if (start.getTime() < now.getTime() + CONFIG.MIN_LEAD_MINUTES * 60000) return { error: "too_soon", message: "Η ώρα αυτή δεν είναι πλέον διαθέσιμη." };
  if (start.getTime() > now.getTime() + (CONFIG.DAYS_AHEAD + 1) * 86400000) return { error: "too_far", message: "Πολύ μακρινή ημερομηνία." };
  if (cellDate(start) !== d.date) return { error: "bad_datetime", message: "Μη έγκυρη ημερομηνία/ώρα." }; // e.g. 2026-02-31

  const startM = toMin(d.time), endM = startM + service[1];
  const ranges = CONFIG.HOURS[start.getDay()] || [];
  if (!ranges.some(r => startM >= toMin(r[0]) && endM <= toMin(r[1]))) return { error: "closed", message: "Το κουρείο είναι κλειστό εκείνη την ώρα." };

  return { service, serviceId: d.service, date: d.date, time: d.time, end: toTime(endM), name, phone, email, notes };
}

function busyFor(dateStr) {
  return busyRange(dateStr, 1)[dateStr];
}

/** Busy intervals for `days` consecutive days starting at fromStr → { "yyyy-MM-dd": [{start,end}], … }
 *  Reads the calendar (or the sheet) only ONCE for the whole range. */
function busyRange(fromStr, days) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(fromStr || "")) throw new Error("bad date");
  const keys = [], starts = [];
  const f = fromStr.split("-").map(Number);
  for (let i = 0; i < days; i++) {
    const d = new Date(f[0], f[1] - 1, f[2] + i);           // script timezone, DST-safe
    starts.push(d); keys.push(cellDate(d));
  }
  const out = {};
  keys.forEach(k => out[k] = []);

  // Online bookings of the last minutes always count (safety net while the calendar syncs).
  recentBookings().forEach(b => { if (out[b.date]) out[b.date].push({ start: b.start, end: b.end }); });

  if (CONFIG.USE_CALENDAR) {
    const rangeEnd = new Date(f[0], f[1] - 1, f[2] + days);
    blockingCalendars()
      .reduce((all, c) => all.concat(c.getEvents(starts[0], rangeEnd)), [])
      .filter(blocks)
      .forEach(ev => {
        const s = ev.getStartTime(), e = ev.getEndTime(), allDay = ev.isAllDayEvent();
        starts.forEach((dayStart, i) => {
          const dayEnd = i + 1 < starts.length ? starts[i + 1] : rangeEnd;
          if (!(s < dayEnd && e > dayStart)) return;                     // event doesn't touch this day
          if (allDay) { out[keys[i]].push({ start: "00:00", end: "23:59" }); return; }
          out[keys[i]].push({
            start: s <= dayStart ? "00:00" : cellTime(s),
            end: e >= dayEnd ? "23:59" : cellTime(e)
          });
        });
      });
    return out;
  }

  sheet().getDataRange().getValues().slice(1).forEach(r => {
    const k = cellDate(r[2]);
    if (out[k] && r[10] !== "Ακυρώθηκε") out[k].push({ start: cellTime(r[3]), end: cellTime(r[4]) });
  });
  return out;
}

/** Does this calendar event block time on the site? */
function blocks(ev) {
  try { if (ev.getMyStatus() === CalendarApp.GuestStatus.NO) return false; } catch (err) {} // invitations he declined
  try {
    // «Τοποθεσία εργασίας» and birthdays are not real appointments
    const t = ev.getEventType();
    if (t === CalendarApp.EventType.WORKING_LOCATION || t === CalendarApp.EventType.BIRTHDAY) return false;
  } catch (err) {}
  return true;
}

/** Cancel link from the customer's email.
 *  First visit only SHOWS the booking with a button; the cancellation happens on the button press.
 *  (Email security scanners open links automatically — they must never cancel an appointment.) */
function cancelPage(id, token, confirmed) {
  const sh = sheet();
  const rows = sh.getDataRange().getValues();
  for (let i = 1; i < rows.length; i++) {
    if (rows[i][0] === id && rows[i][11] === token) {
      const b = { id, date: cellDate(rows[i][2]), time: cellTime(rows[i][3]), end: cellTime(rows[i][4]), serviceName: rows[i][5], name: rows[i][6], phone: String(rows[i][7]), email: rows[i][8] };
      if (rows[i][10] === "Ακυρώθηκε") return page("Το ραντεβού έχει ήδη ακυρωθεί", "Μπορείς να κλείσεις νέο ραντεβού όποτε θέλεις.");
      if (dateAt(b.date, b.time).getTime() < Date.now()) return page("Το ραντεβού έχει περάσει", "Για οτιδήποτε κάλεσε στο " + CONFIG.SHOP_PHONE + ".");
      if (!confirmed) {
        const url = ScriptApp.getService().getUrl() + `?action=cancel&id=${encodeURIComponent(id)}&token=${encodeURIComponent(token)}&confirm=yes`;
        return page("Ακύρωση ραντεβού;",
          `${esc(b.serviceName)}<br><b style="color:#fff">${prettyDate(b.date)} στις ${b.time}</b>`,
          `<a href="${url}" target="_top" style="display:inline-block;margin-top:22px;padding:14px 26px;background:#c9a45c;color:#0b0b0c;font-weight:700;text-decoration:none;border-radius:4px;letter-spacing:1px">ΝΑΙ, ΑΚΥΡΩΣΗ</a>`);
      }
      {
        sh.getRange(i + 1, 11).setValue("Ακυρώθηκε");
        forgetRecent(id);
        bumpGen();
        try { if (CONFIG.USE_CALENDAR) removeFromCalendar(id, b.date); } catch (err) { console.error(err); }
        try {
          sendMail({ to: ownerEmail(), subject: `❌ Ακύρωση: ${b.name} · ${prettyDate(b.date)} ${b.time}`,
            htmlBody: mailShell(`<h2 style="margin:0 0 12px">Ακύρωση ραντεβού</h2><p>Ο/Η <b>${esc(b.name)}</b> ακύρωσε το ραντεβού:</p>${table(b)}<p style="font-size:12px;color:#888">Η ώρα ελευθερώθηκε στο site${CONFIG.USE_CALENDAR ? " και σβήστηκε από το Google Calendar σου" : ""}.</p>`), name: CONFIG.SHOP_NAME });
        } catch (err) { console.error(err); }
      }
      return page("Το ραντεβού ακυρώθηκε", "Ευχαριστούμε που μας ενημέρωσες. Μπορείς να κλείσεις νέο ραντεβού όποτε θέλεις.");
    }
  }
  return page("Δεν βρέθηκε", "Ο σύνδεσμος ακύρωσης δεν είναι έγκυρος.");
}
function page(title, text, extra) {
  return HtmlService.createHtmlOutput(simplePage(title, text, extra)).setTitle(CONFIG.SHOP_NAME);
}

/* ======================= EMAIL ======================= */
function emailCustomer(b) {
  const cancelUrl = ScriptApp.getService().getUrl() + `?action=cancel&id=${b.id}&token=${b.token}`;
  const html = mailShell(`
    <h2 style="margin:0 0 6px;font-size:26px">Το ραντεβού σου επιβεβαιώθηκε ✂️</h2>
    <p style="color:#555;margin:0 0 20px">Γεια σου ${esc(b.name.split(" ")[0])}, σε περιμένουμε!</p>
    ${table(b, true)}
    <p style="margin:22px 0 6px">📍 <b>${CONFIG.SHOP_ADDRESS}</b><br>📞 ${CONFIG.SHOP_PHONE}</p>
    <p style="margin:22px 0 0;font-size:13px;color:#777">Δεν μπορείς να έρθεις; <a href="${cancelUrl}" style="color:#a8823a">Ακύρωσε το ραντεβού</a> ή κάλεσέ μας.</p>`);
  const owner = ownerEmail();
  let attachments = [];
  try { attachments = [ics(b)]; } catch (err) { console.error(err); }
  return sendMail({
    to: b.email, replyTo: isEmail(owner) ? owner : undefined, name: CONFIG.SHOP_NAME,
    subject: `Επιβεβαίωση ραντεβού · ${prettyDate(b.date)} στις ${b.time}`,
    htmlBody: html, attachments
  });
}

function emailOwner(b) {
  const intl = b.phone.replace(/[^\d+]/g, "").replace(/^(?!\+)(?:00)?/, m => m === "" ? "+30" : "+");
  const html = mailShell(`
    <h2 style="margin:0 0 14px;font-size:24px">Νέο ραντεβού 💈</h2>
    ${table(b)}
    <p style="margin:18px 0 4px"><b>Πελάτης:</b> ${esc(b.name)}<br>
    <b>Τηλ:</b> <a href="tel:${intl}">${esc(b.phone)}</a> · <a href="https://wa.me/${intl.replace("+", "")}">WhatsApp</a><br>
    <b>Email:</b> <a href="mailto:${esc(b.email)}">${esc(b.email)}</a></p>
    ${b.notes ? `<p style="background:#f6f1e6;padding:12px 14px;border-radius:6px"><b>Σημείωση:</b> ${esc(b.notes)}</p>` : ""}
    <p style="font-size:12px;color:#888">Κωδικός κράτησης: ${b.id}${CONFIG.USE_CALENDAR ? "<br>Το ραντεβού μπήκε στο Google Calendar σου. Για ακύρωση, σβήσε το γεγονός και η ώρα ελευθερώνεται στο site." : ""}</p>`);
  const owner = ownerEmail();
  if (!isEmail(owner)) return "ΣΦΑΛΜΑ: δεν βρέθηκε το email του ιδιοκτήτη. Συμπλήρωσε το OWNER_EMAIL στο Code.gs.";
  return sendMail({
    to: owner, replyTo: b.email, name: "Κρατήσεις Website",
    subject: `💈 Νέο ραντεβού: ${b.name} · ${prettyDate(b.date)} ${b.time}`,
    htmlBody: html
  });
}

/** Sends an email and returns "OK" or "ΣΦΑΛΜΑ: …". Never throws.
 *  If the full email fails, it retries once with the simplest possible message. */
function sendMail(opts) {
  try {
    if (MailApp.getRemainingDailyQuota() < 1) return "ΣΦΑΛΜΑ: εξαντλήθηκε το ημερήσιο όριο email της Google (ξαναμηδενίζεται σε 24 ώρες).";
  } catch (err) { console.error(err); }
  const clean = {};
  Object.keys(opts).forEach(k => { if (opts[k] !== undefined && !(Array.isArray(opts[k]) && !opts[k].length)) clean[k] = opts[k]; });
  try { MailApp.sendEmail(clean); return "OK"; }
  catch (err) {
    console.error("email 1η προσπάθεια", err);
    try {
      MailApp.sendEmail(opts.to, opts.subject, opts.htmlBody.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim(), { htmlBody: opts.htmlBody, name: opts.name });
      return "OK";
    } catch (err2) {
      console.error("email 2η προσπάθεια", err2);
      return "ΣΦΑΛΜΑ: " + String((err2 && err2.message) || err2).slice(0, 200);
    }
  }
}

/** Writes the email result next to the booking in the sheet (column M «Email»). */
function logMail(b, customer, owner) {
  try {
    const sh = sheet();
    if (!sh.getRange(1, 13).getValue()) sh.getRange(1, 13).setValue("Email").setFontWeight("bold").setBackground("#0b0b0c").setFontColor("#c9a45c");
    const ok = customer === "OK" && owner === "OK";
    const text = ok ? "✓ Στάλθηκαν" : `Πελάτης: ${customer} | Ιδιοκτήτης: ${owner}`;
    if (b.row) sh.getRange(b.row, 13).setValue(text).setFontColor(ok ? "#1b7f3b" : "#c62828");
    if (!ok) console.error("Αποτυχία email για κράτηση " + b.id + ": " + text);
  } catch (err) { console.error(err); }
}
function isEmail(s) { return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(String(s || "")); }

function table(b, withCustomer) {
  const row = (k, v) => `<tr><td style="padding:8px 0;color:#777;width:110px">${k}</td><td style="padding:8px 0;font-weight:600">${v}</td></tr>`;
  return `<table style="border-collapse:collapse;width:100%;border-top:1px solid #eee;border-bottom:1px solid #eee">
    ${row("Υπηρεσία", esc(b.serviceName))}${row("Ημέρα", prettyDate(b.date))}${row("Ώρα", b.time + (b.end ? "–" + b.end : ""))}${b.price ? row("Τιμή", b.price + "€") : ""}${withCustomer ? row("Όνομα", esc(b.name)) + row("Κινητό", esc(b.phone)) + (b.notes ? row("Σημείωση", esc(b.notes)) : "") : ""}</table>`;
}

function mailShell(inner) {
  return `<div style="background:#f3f2ee;padding:28px 12px;font-family:Helvetica,Arial,sans-serif;color:#151515">
    <div style="max-width:520px;margin:0 auto;background:#fff;border-radius:10px;overflow:hidden">
      <div style="background:#0b0b0c;color:#fff;padding:22px 28px;font-size:26px;font-weight:900;letter-spacing:3px">MAKHS
        <span style="display:block;font-size:10px;letter-spacing:5px;color:#c9a45c;font-weight:600">BARBER SHOP</span></div>
      <div style="padding:28px">${inner}</div>
    </div></div>`;
}

function ics(b) {
  const f = t => b.date.replace(/-/g, "") + "T" + t.replace(":", "") + "00";
  const body = [
    "BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Makhs//Booking//EL", "METHOD:PUBLISH",
    "BEGIN:VEVENT", `UID:${b.id}@makhs`, `DTSTAMP:${Utilities.formatDate(new Date(), "UTC", "yyyyMMdd'T'HHmmss'Z'")}`,
    `DTSTART;TZID=Europe/Athens:${f(b.time)}`, `DTEND;TZID=Europe/Athens:${f(b.end)}`,
    `SUMMARY:${b.serviceName} · ${CONFIG.SHOP_NAME}`, `LOCATION:${CONFIG.SHOP_ADDRESS}`,
    `DESCRIPTION:Τηλ. ${CONFIG.SHOP_PHONE}`,
    "BEGIN:VALARM", "TRIGGER:-PT2H", "ACTION:DISPLAY", "DESCRIPTION:Ραντεβού στο κουρείο", "END:VALARM",
    "END:VEVENT", "END:VCALENDAR"
  ].join("\r\n");
  return Utilities.newBlob(body, "text/calendar", "rantevou.ics");
}

/* ======================= CALENDAR ======================= */
function cal() {
  const c = CONFIG.CALENDAR_ID ? CalendarApp.getCalendarById(CONFIG.CALENDAR_ID) : CalendarApp.getDefaultCalendar();
  if (!c) throw new Error("Calendar not found: " + CONFIG.CALENDAR_ID);
  return c;
}

/** Calendars whose events block times on the site.
 *  CALENDAR_ID set → only that one. Otherwise → EVERY calendar the owner owns
 *  (main + any extra ones like «Κουρείο», «Προσωπικά»). Subscribed calendars
 *  such as holidays/birthdays are not owned, so they don't block anything. */
function blockingCalendars() {
  if (CONFIG.CALENDAR_ID) return [cal()];
  const owned = CalendarApp.getAllOwnedCalendars();
  return owned.length ? owned : [CalendarApp.getDefaultCalendar()];
}

function addToCalendar(b) {
  const ev = cal().createEvent(
    `💈 ${b.name} · ${b.serviceName}`, dateAt(b.date, b.time), dateAt(b.date, b.end),
    { description: `Τηλ: ${b.phone}\nEmail: ${b.email}${b.notes ? "\nΣημείωση: " + b.notes : ""}\nID: ${b.id}`, location: CONFIG.SHOP_ADDRESS });
  ev.setTag("makhsId", b.id);
}
function removeFromCalendar(id, dateStr) {
  const day = dateAt(dateStr, "00:00"), next = new Date(day.getTime() + 86400000);
  cal().getEvents(day, next).forEach(ev => { if (ev.getTag("makhsId") === id) ev.deleteEvent(); });
}

/* ======================= HELPERS ======================= */
function sheet() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sh = ss.getSheetByName(CONFIG.SHEET_NAME);
  if (!sh) {
    sh = ss.insertSheet(CONFIG.SHEET_NAME);
    sh.appendRow(HEADERS);
    sh.setFrozenRows(1);
    sh.getRange(1, 1, 1, HEADERS.length).setFontWeight("bold").setBackground("#0b0b0c").setFontColor("#c9a45c");
    sh.getRange("C:E").setNumberFormat("@"); // keep dates/times as plain text
  }
  return sh;
}
function json(o) { return text(JSON.stringify(o)); }
function text(s) { return ContentService.createTextOutput(s).setMimeType(ContentService.MimeType.JSON); }

/* Cache generation: bumped on every booking/cancellation so the site never sees an old cached day. */
function gen() { return CacheService.getScriptCache().get("gen") || "0"; }
function bumpGen() { try { CacheService.getScriptCache().put("gen", String(Date.now()), 21600); } catch (err) { console.error(err); } }

/* Online bookings of the last 5 minutes, kept apart from the calendar as a safety net. */
function recentBookings() {
  try {
    const list = JSON.parse(CacheService.getScriptCache().get("recent") || "[]");
    return list.filter(b => Date.now() - b.t < 5 * 60000);
  } catch (err) { return []; }
}
function rememberRecent(b) {
  const list = recentBookings().concat([{ id: b.id, date: b.date, start: b.time, end: b.end, t: Date.now() }]);
  try { CacheService.getScriptCache().put("recent", JSON.stringify(list), 1800); } catch (err) { console.error(err); }
}
function forgetRecent(id) {
  const list = recentBookings().filter(b => b.id !== id);
  try { CacheService.getScriptCache().put("recent", JSON.stringify(list), 1800); } catch (err) { console.error(err); }
}
function toMin(t) { const p = String(t).split(":"); return +p[0] * 60 + +p[1]; }
function toTime(m) { return ("0" + Math.floor(m / 60)).slice(-2) + ":" + ("0" + (m % 60)).slice(-2); }
function dateAt(dateStr, time) { const d = dateStr.split("-").map(Number), t = time.split(":").map(Number); return new Date(d[0], d[1] - 1, d[2], t[0], t[1]); } // script timezone = Europe/Athens
function cellDate(v) { return v instanceof Date ? Utilities.formatDate(v, Session.getScriptTimeZone(), "yyyy-MM-dd") : String(v); }
function cellTime(v) { return v instanceof Date ? Utilities.formatDate(v, Session.getScriptTimeZone(), "HH:mm") : String(v); }
function prettyDate(s) { const d = dateAt(s, "12:00"); return `${DAYS[d.getDay()]} ${d.getDate()} ${MONTHS_GEN[d.getMonth()]}`; }
function esc(s) { return String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])); }
function simplePage(title, text, extra) {
  return `<meta name="viewport" content="width=device-width,initial-scale=1"><div style="font-family:Helvetica,Arial;background:#0b0b0c;color:#fff;min-height:100vh;display:grid;place-items:center;text-align:center;padding:20px">
  <div><div style="font-size:34px;font-weight:900;letter-spacing:4px">MAKHS</div><h1 style="color:#c9a45c">${title}</h1><p style="color:#aaa;line-height:1.6">${text}</p>${extra || ""}</div></div>`;
}

/** Run once from the editor to grant permissions and create the sheet. */
function setup() {
  sheet();
  if (CONFIG.USE_CALENDAR) {
    Logger.log("Νέα ραντεβού γράφονται στο ημερολόγιο: " + cal().getName());
    Logger.log("Ώρες μπλοκάρονται από τα ημερολόγια: " + blockingCalendars().map(c => c.getName()).join(", "));
  }
  testEmail();
  Logger.log("OK — sheet ready. Οι κρατήσεις θα πηγαίνουν στο: " + ownerEmail() + ". Τώρα: Deploy → New deployment → Web app.");
}

/** Owner email: CONFIG.OWNER_EMAIL, or the Google account that deployed the web app. */
function ownerEmail() {
  const set = String(CONFIG.OWNER_EMAIL || "").trim();
  if (isEmail(set)) return set;
  let me = "";
  try { me = Session.getEffectiveUser().getEmail(); } catch (err) { console.error(err); }
  if (!me) try { me = Session.getActiveUser().getEmail(); } catch (err) { console.error(err); }
  return me;
}

/** ▶ Run this from the editor if emails stop arriving.
 *  It shows the exact problem in the «Execution log» and, if Google needs permissions
 *  again, it opens the authorization window. */
function testEmail() {
  const to = ownerEmail();
  Logger.log("Email ιδιοκτήτη: " + (to || "(ΚΕΝΟ: συμπλήρωσε το OWNER_EMAIL)"));
  Logger.log("Υπόλοιπο ημερήσιου ορίου email: " + MailApp.getRemainingDailyQuota());
  MailApp.sendEmail({ to, name: CONFIG.SHOP_NAME, subject: "✅ Δοκιμή email · κρατήσεις " + CONFIG.SHOP_NAME,
    htmlBody: mailShell(`<h2 style="margin:0 0 10px">Τα email δουλεύουν ✅</h2><p>Αυτό είναι δοκιμαστικό μήνυμα από το σύστημα κρατήσεων.</p>`) });
  Logger.log("ΟΚ: στάλθηκε δοκιμαστικό email στο " + to + ". Τώρα: Deploy → Manage deployments → Edit → New version → Deploy.");
}
