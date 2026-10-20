// Loads ../index.html at fixed dates and prints what each person sees, gate by gate
// in page order, so a change to gates, rotas, meals, laundry, or bins can be checked
// before it's pushed. "due" lists the cards tagged Today, Tonight, or Still to finish.
//
// Usage:  cd tools && npm install && npm run check            (today and the next 13 days)
//         cd tools && npm run check -- 2026-12-29 2027-01-01  (specific dates)
//
// Exits non-zero if the page's script throws on any date, or a card sits outside a gate.

const fs = require("fs");
const path = require("path");
const { JSDOM } = require("jsdom");

const html = fs.readFileSync(path.join(__dirname, "..", "index.html"), "utf8");
const PEOPLE = ["everyone", "aurora", "eshaal", "leo", "dad"];

function load(dateStr) {
  const fixed = new Date(dateStr + "T12:00:00").getTime();
  const errors = [];
  const dom = new JSDOM(html, {
    runScripts: "dangerously",
    url: "https://example.test/",
    beforeParse(w) {
      const Real = w.Date;
      class Fixed extends Real {
        constructor(...a) { if (a.length === 0) super(fixed); else super(...a); }
        static now() { return fixed; }
      }
      w.Date = Fixed;
      w.addEventListener("error", (e) => errors.push(e.message));
    },
  });
  return { doc: dom.window.document, errors };
}

// Visible gates and the visible cards in each, as "gate: card card".
function gates(doc) {
  return Array.from(doc.querySelectorAll("section.gate"))
    .filter((s) => !s.hidden)
    .map((s) => s.id.replace(/^g-/, "") + ": " + Array.from(s.querySelectorAll(".sop")).filter((c) => !c.hidden).map((c) => c.id).join(" "));
}

function report(dateStr) {
  const { doc, errors } = load(dateStr);
  console.log("\n=== " + dateStr + " ===");
  if (errors.length) {
    console.log("SCRIPT ERRORS: " + errors.join("; "));
    process.exitCode = 1;
    return;
  }
  const loose = Array.from(doc.querySelectorAll(".sop")).filter((c) => !c.closest("section.gate")).map((c) => c.id);
  if (loose.length) {
    console.log("CARDS OUTSIDE A GATE: " + loose.join(", "));
    process.exitCode = 1;
  }
  for (const p of PEOPLE) {
    doc.getElementById("who-" + p).click();
    const due = Array.from(doc.querySelectorAll(".sop"))
      .filter((c) => !c.hidden && Array.from(c.querySelectorAll(".tag")).some((t) => /^(Today|Tonight|Still to finish)/.test(t.textContent)))
      .map((c) => c.id);
    if (p === "everyone") {
      const today = doc.querySelector("#week-body .today");
      console.log(today ? today.textContent : "(no today line)");
      console.log("  morning gate: " + doc.getElementById("g-morning-h").textContent + (due.length ? "  |  due: " + due.join(", ") : ""));
      continue;
    }
    console.log("  " + p.padEnd(7) + gates(doc).join("  |  ") + (due.length ? "\n           due: " + due.join(", ") : ""));
  }
}

const pad = (n) => String(n).padStart(2, "0");
const args = process.argv.slice(2);
const dates = args.length
  ? args
  : Array.from({ length: 14 }, (_, i) => {
      const d = new Date();
      d.setDate(d.getDate() + i);
      return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate());
    });
dates.forEach(report);
