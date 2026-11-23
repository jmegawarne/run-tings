// Meal scores from the Routines page, straight into this spreadsheet's Ratings tab. Tidy claims too, in a
// Tidies tab of their own, where they wait for Dad's decision.
//
// The master copy is apps-script/ratings.gs in the run-tings repo. To install it: in the spreadsheet,
// Extensions > Apps Script, replace what's there with this file, save, then Deploy > New deployment >
// Web app, Execute as: Me, Who has access: Anyone. Authorise it, and put the web app URL in RATINGS_URL
// in index.html. After any edit here: Deploy > Manage deployments > edit > Version: New version, which
// keeps the same URL.
//
// The page is public, so anyone can call this. All it will do is put a 1 to 5 score, and a short note,
// against a meal already in the sheet from the last few days, in one of the page's people's columns; and add a
// tidy claim, a few a day at most, or decide one. Deciding needs no password: Dad's call (23 Nov 2026).
// It finds columns by their headings, so the sheet's layout can change as long as these stay:
// Date, Meal, Dish, Note, and a column for each name in COLUMN.
//
// The line below limits the script to this one spreadsheet. Without it, Google asks for every spreadsheet
// you own. Keep it.
/** @OnlyCurrentDoc */
//
// GET  ?date=YYYY-MM-DD&who=Leo
//      -> { ok: true, rows: [{ meal, dish, score }] }, score being that person's own, or 0.
// POST { date, who, scores: [{ dish, score, note }] }, sent as plain text
//      -> { ok: true, saved: n }, or { ok: false, error: "..." }.
//
// Tidies. The page works out the points (its card's time, the claimer's handicap, and the together bonus), and
// each phone pays out its own from the decisions it's told about here.
// GET  ?tidy=1&who=Leo
//      -> { ok: true, claims: [...], badges: [{ who, kind, until }], gapHours }. Dad gets every claim from the
//         last TIDY_DAYS; anyone else gets the ones they claimed or called. Each claim is
//         { id, at, who, room, with, photosBy, pts, decision, caller, decided }; decision is "" while it waits.
// POST { tidy: "claim", who, room, with, photosBy, pts } -> { ok: true, id }
// POST { tidy: "decide", id, decision, caller } -> { ok: true }. Decision is approve, no, owned, cobra, or wolf,
//      or "" to put it back in the list. Owned, cobra, and wolf need the caller.

const TAB = "Ratings";
const COLUMN = { Dad: "Justin", Aurora: "Aurora", Leo: "Leo" }; // Name on the page to column heading.
const DAYS_BACK = 2; // How many days back a score can still go in or change.
const NOTE_MAX = 140;
const MOST_DISHES = 6;

const TIDY_TAB = "Tidies"; // Made, with its headings, on the first claim.
const TIDY_HEAD = ["Id", "Claimed", "Who", "Room", "With", "Photos by", "Points", "Decision", "Caller", "Decided"];
const TIDY_GAP_HOURS = 3; // A person can claim the same room once in this many hours.
const TIDY_DAYS = 21; // How far back the page is told about claims.
const TIDY_BADGE_DAYS = 7; // How long a Cobra's snake, or a wolf, stays on a name.
const TIDY_MOST_A_DAY = 20; // Claims per person per day, so the public URL can't fill the tab.
const DECISIONS = ["approve", "no", "owned", "cobra", "wolf"];

function doGet(e) {
  return reply_(() => {
    const p = (e && e.parameter) || {};
    if (p.tidy) return tidyGet_(p.who);
    const t = table_();
    const col = personCol_(t, p.who);
    checkDate_(t, p.date);
    return {
      rows: t.rows.filter((r) => r.date === p.date).map((r) => ({
        meal: String(r.values[t.col.Meal] || ""),
        dish: String(r.values[t.col.Dish] || ""),
        score: Number(r.values[col]) || 0
      }))
    };
  });
}

function doPost(e) {
  return reply_(() => {
    let body;
    try {
      body = JSON.parse(e.postData.contents);
    } catch (err) {
      throw new Error("That wasn't a score.");
    }
    const lock = LockService.getScriptLock();
    lock.waitLock(10000);
    try {
      if (body && body.tidy === "claim") return tidyClaim_(body);
      if (body && body.tidy === "decide") return tidyDecide_(body);
      const t = table_();
      const col = personCol_(t, body.who);
      checkDate_(t, body.date);
      const stamp = " (" + COLUMN[body.who] + ", " + Utilities.formatDate(new Date(), t.tz, "d MMM") + ")";
      let saved = 0;
      (Array.isArray(body.scores) ? body.scores : []).slice(0, MOST_DISHES).forEach((s) => {
        const dish = String((s && s.dish) || "").trim().toLowerCase();
        const row = t.rows.find((r) => r.date === body.date && String(r.values[t.col.Dish]).trim().toLowerCase() === dish);
        if (!dish || !row) return;
        let did = false;
        const score = Number(s.score);
        if (Number.isInteger(score) && score >= 1 && score <= 5) {
          t.sheet.getRange(row.n, col + 1).setValue(score);
          did = true;
        }
        const note = clean_(s.note);
        if (note) {
          const cell = t.sheet.getRange(row.n, t.col.Note + 1);
          const was = String(cell.getValue() || "").trim();
          if (was.toLowerCase().indexOf(note.toLowerCase()) < 0) cell.setValue(was ? was + "; " + note + stamp : note + stamp);
          did = true;
        }
        if (did) saved++;
      });
      if (!saved) throw new Error("Nothing matched today's meals in the sheet.");
      return { saved: saved };
    } finally {
      lock.releaseLock();
    }
  });
}

// The Ratings tab as rows, with each row's date as YYYY-MM-DD in the spreadsheet's own time zone.
function table_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(TAB);
  if (!sheet) throw new Error("No " + TAB + " tab.");
  const tz = ss.getSpreadsheetTimeZone();
  const values = sheet.getDataRange().getValues();
  const col = {};
  values[0].forEach((h, i) => {
    const k = String(h).trim();
    if (k && !(k in col)) col[k] = i;
  });
  ["Date", "Meal", "Dish", "Note"].forEach((h) => {
    if (!(h in col)) throw new Error("No " + h + " column.");
  });
  const rows = values.slice(1).map((v, i) => ({
    n: i + 2,
    values: v,
    date: v[col.Date] instanceof Date ? Utilities.formatDate(v[col.Date], tz, "yyyy-MM-dd") : ""
  }));
  return { sheet: sheet, tz: tz, col: col, rows: rows };
}

function personCol_(t, who) {
  const name = Object.prototype.hasOwnProperty.call(COLUMN, who) ? COLUMN[who] : "";
  if (!name || !(name in t.col)) throw new Error("Pick your name on the page first.");
  return t.col[name];
}

// Only today and the last DAYS_BACK days, so nobody can rewrite old scores.
function checkDate_(t, date) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date || ""))) throw new Error("No date.");
  const today = Utilities.formatDate(new Date(), t.tz, "yyyy-MM-dd");
  const back = (Date.parse(today) - Date.parse(date)) / 864e5;
  if (!(back >= 0 && back <= DAYS_BACK)) throw new Error("Scores for that day are closed.");
}

/* ---------- Tidies ---------- */
const APPROVER = "Dad"; // The page name whose list the claims wait on.

function pageName_(who) {
  if (!Object.prototype.hasOwnProperty.call(COLUMN, who)) throw new Error("Pick your name on the page first.");
  return who;
}

// The Tidies tab as claims, found by their headings. Made, headings and all, the first time it's needed.
function tidies_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(TIDY_TAB);
  if (!sheet) {
    sheet = ss.insertSheet(TIDY_TAB);
    sheet.appendRow(TIDY_HEAD);
    sheet.setFrozenRows(1);
  }
  const values = sheet.getDataRange().getValues();
  const col = {};
  values[0].forEach((h, i) => {
    const k = String(h).trim();
    if (k && !(k in col)) col[k] = i;
  });
  TIDY_HEAD.forEach((h) => {
    if (!(h in col)) throw new Error("No " + h + " column in " + TIDY_TAB + ".");
  });
  const time = (v) => (v instanceof Date ? v.getTime() : 0);
  const claims = values.slice(1).map((v, i) => ({
    n: i + 2,
    id: String(v[col.Id] || ""),
    at: time(v[col.Claimed]),
    who: String(v[col.Who] || ""),
    room: String(v[col.Room] || ""),
    with: String(v[col.With] || ""),
    photosBy: String(v[col["Photos by"]] || ""),
    pts: Number(v[col.Points]) || 0,
    decision: String(v[col.Decision] || "").trim().toLowerCase(),
    caller: String(v[col.Caller] || "").trim(),
    decided: time(v[col.Decided])
  })).filter((c) => c.id);
  return { sheet: sheet, col: col, width: values[0].length, claims: claims };
}

function tidyGet_(who) {
  const name = pageName_(who);
  const now = Date.now();
  const recent = tidies_().claims.filter((c) => c.at > now - TIDY_DAYS * 864e5);
  const iso = (ms) => (ms ? new Date(ms).toISOString() : "");
  // A Cobra's snake goes on the claimer, a wolf on the caller, for a week from the decision.
  const badges = [];
  recent.forEach((c) => {
    const until = c.decided + TIDY_BADGE_DAYS * 864e5;
    if (!c.decided || until <= now) return;
    if (c.decision === "cobra") badges.push({ who: c.who, kind: "cobra", until: iso(until) });
    if (c.decision === "wolf" && c.caller) badges.push({ who: c.caller, kind: "wolf", until: iso(until) });
  });
  const theirs = name === APPROVER ? recent : recent.filter((c) => c.who === name || c.caller === name);
  return {
    claims: theirs.map((c) => ({
      id: c.id, at: iso(c.at), who: c.who, room: c.room, with: c.with, photosBy: c.photosBy, pts: c.pts,
      decision: DECISIONS.indexOf(c.decision) > -1 ? c.decision : "", caller: c.caller, decided: iso(c.decided)
    })),
    badges: badges,
    gapHours: TIDY_GAP_HOURS
  };
}

function tidyClaim_(body) {
  const who = pageName_(body.who);
  const room = clean_(body.room).slice(0, 40);
  if (!room) throw new Error("Which room?");
  const mate = body.with ? pageName_(body.with) : "";
  if (mate === who) throw new Error("You can't tidy with yourself.");
  const photosBy = body.photosBy ? pageName_(body.photosBy) : who;
  if (photosBy !== who && photosBy !== mate) throw new Error("The photos come from you, or whoever helped.");
  const pts = Math.round(Number(body.pts));
  if (!(pts >= 1 && pts <= 1000)) throw new Error("Those points don't look right.");
  const t = tidies_();
  const now = Date.now();
  if (t.claims.some((c) => c.who === who && c.room.toLowerCase() === room.toLowerCase() && c.at > now - TIDY_GAP_HOURS * 36e5)) {
    throw new Error("You claimed the " + room.toLowerCase() + " in the last " + TIDY_GAP_HOURS + " hours.");
  }
  if (t.claims.filter((c) => c.who === who && c.at > now - 864e5).length >= TIDY_MOST_A_DAY) {
    throw new Error("That's a lot of tidying for one day. Tell Dad.");
  }
  const id = Utilities.getUuid().replace(/-/g, "").slice(0, 12);
  const row = new Array(t.width).fill("");
  row[t.col.Id] = id;
  row[t.col.Claimed] = new Date(now);
  row[t.col.Who] = who;
  row[t.col.Room] = room;
  row[t.col.With] = mate;
  row[t.col["Photos by"]] = photosBy;
  row[t.col.Points] = pts;
  t.sheet.appendRow(row);
  return { id: id };
}

function tidyDecide_(body) {
  const t = tidies_();
  const c = t.claims.find((x) => x.id === String(body.id || ""));
  if (!c) throw new Error("That claim isn't in the list.");
  const decision = String(body.decision || "");
  if (decision && DECISIONS.indexOf(decision) < 0) throw new Error("Approve, no, owned, cobra, or wolf.");
  const called = decision === "owned" || decision === "cobra" || decision === "wolf";
  if (called && !body.caller) throw new Error("Who called it?");
  const caller = called ? pageName_(body.caller) : "";
  if (called && (caller === c.who || caller === c.with || caller === APPROVER)) throw new Error("Only someone else who could have claimed it can call it.");
  const put = (h, v) => t.sheet.getRange(c.n, t.col[h] + 1).setValue(v);
  put("Decision", decision);
  put("Caller", caller);
  put("Decided", decision ? new Date() : "");
  return {};
}

// A note as plain words: one line, short, and never a formula.
function clean_(s) {
  return String(s || "").replace(/\s+/g, " ").trim().replace(/^[=+\-@\s]+/, "").slice(0, NOTE_MAX).trim();
}

function reply_(fn) {
  let out;
  try {
    out = Object.assign({ ok: true }, fn());
  } catch (err) {
    out = { ok: false, error: String((err && err.message) || err) };
  }
  return ContentService.createTextOutput(JSON.stringify(out)).setMimeType(ContentService.MimeType.JSON);
}
