// Meal scores from the Routines page, straight into this spreadsheet's Ratings tab.
//
// The master copy is apps-script/ratings.gs in the run-tings repo. To install it: in the spreadsheet,
// Extensions > Apps Script, replace what's there with this file, save, then Deploy > New deployment >
// Web app, Execute as: Me, Who has access: Anyone. Authorise it, and put the web app URL in RATINGS_URL
// in index.html. After any edit here: Deploy > Manage deployments > edit > Version: New version, which
// keeps the same URL.
//
// The page is public, so anyone can call this. All it will do is put a 1 to 5 score, and a short note,
// against a meal already in the sheet from the last few days, in one of the page's people's columns.
// It finds columns by their headings, so the sheet's layout can change as long as these stay:
// Date, Meal, Dish, Note, and a column for each name in COLUMN.
//
// GET  ?date=YYYY-MM-DD&who=Leo
//      -> { ok: true, rows: [{ meal, dish, score }] }, score being that person's own, or 0.
// POST { date, who, scores: [{ dish, score, note }] }, sent as plain text
//      -> { ok: true, saved: n }, or { ok: false, error: "..." }.

const TAB = "Ratings";
const COLUMN = { Dad: "Justin", Aurora: "Aurora", Leo: "Leo" }; // Name on the page to column heading.
const DAYS_BACK = 2; // How many days back a score can still go in or change.
const NOTE_MAX = 140;
const MOST_DISHES = 6;

function doGet(e) {
  return reply_(() => {
    const p = (e && e.parameter) || {};
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
