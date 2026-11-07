#!/usr/bin/env python3
# Renders ../index.html at phone width, as each person, in light and dark, with every
# card and the by-day table open, so steps, layout, and each person's theme can be
# checked by eye before a change is pushed. check.js says which cards show; this shows them.
#
# Usage:  python3 tools/phone.py                          (today)
#         python3 tools/phone.py 2026-10-20 2026-10-25    (specific dates)
#         python3 tools/phone.py --who aurora,leo --scheme dark 2026-10-20
#
# Needs Python Playwright with Chromium. The cloud session has both; elsewhere:
#   pip install playwright && python3 -m playwright install chromium
# The page is served from a local web server, so it reads recipes.json as it does live.
# A first visit, before any name is picked, is shot as "nobody": the header and This week.
# Each person's screens get their own screenshots: the header, the points bar, the bar along
# the bottom, This week, the tab row as Tasks opens it, each moment with its tab opened first,
# Skills, Safety, the scoreboard pop-up, and the end-of-day screen from Close the day. They're
# named date-scheme-person-part.png, in a folder outside the repo (printed at the end), so they
# never get committed. Each line of output names the moment Tasks opened on for that person.
# It doesn't tick boxes unless asked: with --tick, it ticks every step of the first card Tasks opens
# on, before the shots, so a card done, progress, and points show too.
# Animations are settled before each shot. Exits non-zero if the page throws, scrolls sideways,
# shows more than This week before a name is picked, or a link to a moment (#g-any) doesn't open it.

import argparse
import datetime
import functools
import http.server
import os
import sys
import tempfile
import threading

from playwright.sync_api import sync_playwright

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PEOPLE = ["aurora", "eshaal", "leo", "dad"]
SCHEMES = ["light", "dark"]
WIDTH, HEIGHT = 390, 844  # a typical phone, in CSS pixels
# The points bar sticks to the top and the views bar to the bottom, so for every other shot they're
# moved out of the way, or they'd land on it. Pop-ups are laid out at the top of the page at full
# height, so a long one is shot whole.
FLAT = ".hud { position: static !important; } .views, .toasts { display: none !important; }"
POPUP = FLAT + (" .modal, .win { position: absolute !important; inset: 0 0 auto 0 !important; min-height: 100vh; place-items: start center !important; }"
                " .sheet, .win-card { max-height: none !important; }")


class QuietHandler(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *args):
        pass


def listed(value, allowed, what, parser):
    items = [v.strip() for v in value.split(",") if v.strip()]
    unknown = [v for v in items if v not in allowed]
    if unknown or not items:
        parser.error("%s must be from: %s" % (what, ", ".join(allowed)))
    return items


def main():
    parser = argparse.ArgumentParser(description="Render the Routines page at phone width.")
    parser.add_argument("dates", nargs="*", help="dates as YYYY-MM-DD (default: today)")
    parser.add_argument("--who", default=",".join(PEOPLE), help="comma-separated (default: all)")
    parser.add_argument("--scheme", default=",".join(SCHEMES), help="light, dark, or both (default: both)")
    parser.add_argument("--out", default=os.path.join(tempfile.gettempdir(), "run-tings-phone"), help="folder for the screenshots")
    parser.add_argument("--tick", action="store_true", help="tick every step of the first card Tasks opens on")
    args = parser.parse_args()

    who = listed(args.who, PEOPLE, "--who", parser)
    schemes = listed(args.scheme, SCHEMES, "--scheme", parser)
    dates = args.dates or [datetime.date.today().isoformat()]
    for d in dates:
        try:
            datetime.date.fromisoformat(d)
        except ValueError:
            parser.error("not a date: " + d)
    os.makedirs(args.out, exist_ok=True)

    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), functools.partial(QuietHandler, directory=ROOT))
    threading.Thread(target=server.serve_forever, daemon=True).start()
    url = "http://127.0.0.1:%d/index.html" % server.server_address[1]

    failed = False
    try:
        with sync_playwright() as p:
            browser = p.chromium.launch()
            for d in dates:
                # Midday UTC is the same calendar day in London, whatever the clocks are doing.
                moment = datetime.datetime.fromisoformat(d + "T12:00:00+00:00")
                for scheme in schemes:
                    context = browser.new_context(
                        viewport={"width": WIDTH, "height": HEIGHT}, device_scale_factor=2,
                        is_mobile=True, has_touch=True, color_scheme=scheme, timezone_id="Europe/London")
                    page = context.new_page()
                    errors = []
                    page.on("pageerror", lambda e: errors.append(str(e)))
                    page.clock.set_fixed_time(moment)
                    page.goto(url, wait_until="networkidle")  # lets the recipes fetch finish
                    # A first visit, before a name is picked: the default look and only This week, as "nobody".
                    first = []
                    for name, sel in [("header", "body > header"), ("week", "#v-week")]:
                        part = page.locator(sel)
                        if part.count() and part.is_visible():
                            part.screenshot(path=os.path.join(args.out, "%s-%s-nobody-%s.png" % (d, scheme, name)), animations="disabled", style=FLAT)
                            first.append(name)
                    extra = page.evaluate("['#hud', '#views', '#to-tasks', '#v-tasks', '#v-skills'].filter((s) => { const e = document.querySelector(s); return e && !e.hidden; })")
                    problems = (["shows " + " ".join(extra) + " with no name"] if extra else []) + (["script error: " + "; ".join(errors)] if errors else [])
                    failed = failed or bool(problems)
                    print("%s  %-5s  %-8s  %-4s  %s" % (d, scheme, "nobody", ", ".join(problems) or "ok", " ".join(first)))
                    errors.clear()
                    for person in who:
                        page.click("#who-" + person)
                        page.evaluate("document.querySelectorAll('details').forEach((el) => { el.open = true; })")
                        page.wait_for_timeout(100)
                        shown = []
                        sideways = []

                        def shoot(name, part, style=FLAT):
                            if part.count() and part.is_visible():
                                part.screenshot(path=os.path.join(args.out, "%s-%s-%s-%s.png" % (d, scheme, person, name)),
                                                animations="disabled", style=style)
                                shown.append(name)

                        def view(vid):
                            page.click('#views [data-view="%s"]' % vid)
                            page.wait_for_timeout(50)
                            if page.evaluate("document.documentElement.scrollWidth > window.innerWidth"):
                                sideways.append(vid.replace("v-", "", 1))

                        if args.tick:
                            view("v-tasks")
                            page.evaluate("""() => {
                                const sec = document.querySelector('#v-tasks > section.gate:not(.off):not([hidden])');
                                const card = sec && sec.querySelector('.sop:not([hidden])');
                                if (card) card.querySelectorAll('ol.steps > li:not([hidden]) input').forEach((b) => { if (!b.checked) b.click(); });
                            }""")
                            page.wait_for_timeout(1000)
                        shoot("header", page.locator("body > header"))
                        shoot("hud", page.locator("#hud"), "")
                        shoot("views", page.locator("#views"), "")
                        view("v-week")
                        shoot("week", page.locator("#v-week"))
                        view("v-tasks")
                        opens = page.evaluate("(document.querySelector('#tabs [aria-selected=\"true\"]') || { id: '' }).id.replace('tab-g-', '')")
                        shoot("tabs", page.locator("#jump"))
                        for s in page.locator("#v-tasks > section.gate").all():
                            # A moment's cards only show while its tab is open.
                            sid = s.get_attribute("id")
                            tab = page.locator("#tab-" + sid)
                            if tab.count() and tab.is_visible():
                                tab.click()
                                page.wait_for_timeout(50)
                            shoot(sid.replace("g-", "", 1), s)
                        view("v-skills")
                        shoot("skills", page.locator("#skills"))
                        shoot("safety", page.locator("#safety"))
                        page.click("#hud")
                        shoot("score", page.locator("#score .sheet"), POPUP)
                        page.keyboard.press("Escape")
                        view("v-tasks")
                        page.click("#close-day")
                        shoot("end", page.locator("#win .win-card"), POPUP)
                        page.keyboard.press("Escape")
                        view("v-week")
                        # A link to a moment, as a reminder sends, opens Tasks on it. Any time shows every day.
                        page.evaluate("location.hash = '#g-any'")
                        page.wait_for_timeout(100)
                        linked = page.evaluate("!document.getElementById('v-tasks').hidden && document.getElementById('tab-g-any').getAttribute('aria-selected') === 'true' && !location.hash")
                        view("v-week")
                        problems = (["scrolls sideways in " + ", ".join(sideways)] if sideways else []) + ([] if linked else ["a link to #g-any doesn't open it"]) + (["script error: " + "; ".join(errors)] if errors else [])
                        failed = failed or bool(problems)
                        print("%s  %-5s  %-8s  %-4s  opens %-10s %s" % (d, scheme, person, ", ".join(problems) or "ok", opens or "-", " ".join(shown)))
                        errors.clear()
                    context.close()
            browser.close()
    finally:
        server.shutdown()

    print("\nScreenshots: " + args.out)
    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    main()
