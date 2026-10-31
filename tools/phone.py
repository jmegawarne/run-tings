#!/usr/bin/env python3
# Renders ../index.html at phone width, as everyone and as each person, in light and
# dark, with every card and the by-day table open, so steps and layout can be checked
# by eye before a change is pushed. check.js says which cards show; this shows them.
#
# Usage:  python3 tools/phone.py                          (today)
#         python3 tools/phone.py 2026-10-20 2026-10-25    (specific dates)
#         python3 tools/phone.py --who aurora,leo --scheme dark 2026-10-20
#
# Needs Python Playwright with Chromium. The cloud session has both; elsewhere:
#   pip install playwright && python3 -m playwright install chromium
# The page is served from a local web server, so it reads recipes.json as it does live.
# The header, the points bar, the jump links, and each visible section (This week, each gate,
# Scoreboard, Skills, Safety) get their own screenshot, named date-scheme-person-section.png,
# in a folder outside the repo (printed at the end), so they never get committed. Animations
# are settled before each shot. Exits non-zero if the page throws, or scrolls sideways.

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
PEOPLE = ["everyone", "aurora", "eshaal", "leo", "dad"]
SCHEMES = ["light", "dark"]
WIDTH, HEIGHT = 390, 844  # a typical phone, in CSS pixels


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
    parser = argparse.ArgumentParser(description="Render the House SOPs page at phone width.")
    parser.add_argument("dates", nargs="*", help="dates as YYYY-MM-DD (default: today)")
    parser.add_argument("--who", default=",".join(PEOPLE), help="comma-separated (default: all)")
    parser.add_argument("--scheme", default=",".join(SCHEMES), help="light, dark, or both (default: both)")
    parser.add_argument("--out", default=os.path.join(tempfile.gettempdir(), "run-tings-phone"), help="folder for the screenshots")
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
                    for person in who:
                        page.click("#who-" + person)
                        page.evaluate("document.querySelectorAll('details').forEach((el) => { el.open = true; })")
                        page.wait_for_timeout(100)
                        sideways = page.evaluate("document.documentElement.scrollWidth > window.innerWidth")
                        shown = []
                        parts = [("header", page.locator("body > header")), ("hud", page.locator("#hud")), ("jump", page.locator("body > nav"))]
                        parts += [(s.get_attribute("id").replace("g-", "", 1), s) for s in page.locator("body > section[id]").all()]
                        for name, part in parts:
                            if part.count() and part.is_visible():
                                # The points bar sticks to the top of the screen, so it's unstuck for the other shots or it lands on them.
                                part.screenshot(path=os.path.join(args.out, "%s-%s-%s-%s.png" % (d, scheme, person, name)), animations="disabled",
                                                style="" if name == "hud" else ".hud { position: static !important; }")
                                shown.append(name)
                        problems = (["scrolls sideways"] if sideways else []) + (["script error: " + "; ".join(errors)] if errors else [])
                        failed = failed or bool(problems)
                        print("%s  %-5s  %-8s  %-4s  %s" % (d, scheme, person, ", ".join(problems) or "ok", " ".join(shown)))
                        errors.clear()
                    context.close()
            browser.close()
    finally:
        server.shutdown()

    print("\nScreenshots: " + args.out)
    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    main()
