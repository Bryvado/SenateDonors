"""Rerunnable performance and correctness audit for the SenateDonors map.

Needs Playwright (pip install playwright) and a Chromium; not part of the site.

  python3 scripts/audit_site.py serve [--port 8000] [--deploy N]
      Static server that mimics GitHub Pages: gzip for text types, cache-control
      max-age=600, ETag "<mtime hex>-<size hex>" with the mtime replaced by a fake
      deploy time (--deploy), so a "redeploy" changes every ETag as on Pages.
  python3 scripts/audit_site.py visit URL [--runs 3] [--profiles desktop,mobile]
      [--throttle none,fast4g] [--out FILE]
      First-time-visitor walkthrough; per step: duration, long tasks, bytes, heap.
      Reports the median of the runs.
  python3 scripts/audit_site.py repeat URL [--throttle fast4g]
      First visit, reload (warm), and reload after a simulated redeploy (needs the
      server from `serve`; the script bumps its deploy stamp through /__deploy).
  python3 scripts/audit_site.py geometry URL [--out FILE]
      Every geometry file: wire/decompressed bytes, features, vertices, decimals,
      and in-browser fetch / gunzip+parse / first draw times.
  python3 scripts/audit_site.py headers URL
      cache-control / etag / content-encoding for representative files.
  python3 scripts/audit_site.py values URL --out FILE
      Dumps the values the app computes (state totals, every ZIP and every area at
      each level for TX and CA, for every candidate and period) to diff before/after.
  python3 scripts/audit_site.py nocache URL
      Loads the page with Cache Storage disabled to check graceful degradation.
"""

import argparse
import collections
import gzip
import http.server
import json
import os
import re
import statistics
import sys
import time
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
# --expose-gc lets heap readings be taken after a full collection, so they show retained memory.
CHROMIUM_ARGS = ["--enable-precise-memory-info", "--js-flags=--expose-gc"]
# Chrome DevTools "Fast 4G" preset (NetworkManager.ts): 9 / 1.5 Mbit/s * 0.9, 60 ms * 2.75.
FAST4G = {"offline": False, "latency": 165, "downloadThroughput": 9e6 / 8 * .9, "uploadThroughput": 1.5e6 / 8 * .9}
PROFILES = {"desktop": {"viewport": {"width": 1440, "height": 900}},
            "mobile": {"viewport": {"width": 390, "height": 844}, "is_mobile": True, "has_touch": True, "device_scale_factor": 3}}
GZIP_TYPES = (".html", ".js", ".css", ".json", ".csv", ".txt", ".svg")


# ---------------------------------------------------------------- server
class PagesHandler(http.server.SimpleHTTPRequestHandler):
    deploy = [int(time.time())]
    max_age = 600

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def log_message(self, *args):
        pass

    def do_GET(self):
        path = self.path.split("?", 1)[0]
        if path == "/__deploy":
            self.deploy[0] += 1
            self.send_response(204)
            self.end_headers()
            return
        target = Path(self.translate_path(path))
        if target.is_dir():
            target = target / "index.html"
        if not target.is_file():
            self.send_error(404)
            return
        body = target.read_bytes()
        etag = f'"{self.deploy[0]:x}-{len(body):x}"'
        if self.headers.get("If-None-Match") == etag:
            self.send_response(304)
            self.send_header("ETag", etag)
            self.send_header("Cache-Control", f"max-age={self.max_age}")
            self.end_headers()
            return
        gz = target.suffix in GZIP_TYPES and "gzip" in self.headers.get("Accept-Encoding", "")
        if gz:
            body = gzip.compress(body, 6)
        self.send_response(200)
        self.send_header("Content-Type", self.guess_type(str(target)))
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", f"max-age={self.max_age}")
        self.send_header("ETag", etag)
        self.send_header("Access-Control-Allow-Origin", "*")
        if gz:
            self.send_header("Content-Encoding", "gzip")
            self.send_header("Vary", "Accept-Encoding")
        self.end_headers()
        self.wfile.write(body)


def serve(args):
    PagesHandler.deploy[0] = args.deploy or int(time.time())
    # --max-age 0 makes every reload revalidate, as a visit more than ten minutes later would.
    PagesHandler.max_age = args.max_age
    server = http.server.ThreadingHTTPServer(("127.0.0.1", args.port), PagesHandler)
    print(f"serving {ROOT} on http://127.0.0.1:{args.port}/", flush=True)
    server.serve_forever()


# ---------------------------------------------------------------- browser helpers
def chromium(p):
    exe = os.environ.get("CHROMIUM") or next((str(x) for x in Path("/opt/pw-browsers").glob("chromium-*/chrome-linux/chrome")), None)
    return p.chromium.launch(executable_path=exe, args=CHROMIUM_ARGS) if exe else p.chromium.launch(args=CHROMIUM_ARGS)


# Installed before any page script: long-task and paint observers plus a hook that
# records when the first state polygon is drawn.
INIT = """
window.__audit = {longtasks: [], firstMap: null};
performance.setResourceTimingBufferSize(100000);
new PerformanceObserver(list => { for (const e of list.getEntries()) __audit.longtasks.push([e.startTime, e.duration]); })
  .observe({type: 'longtask', buffered: true});
new MutationObserver((m, obs) => {
  const pane = document.querySelector('.leaflet-state-pane path, .leaflet-state-pane canvas');
  if (pane && __audit.firstMap === null) { __audit.firstMap = performance.now(); obs.disconnect(); }
}).observe(document, {childList: true, subtree: true});
"""
if os.environ.get("AUDIT_BLOCK_TILES", "1") == "1":
    TILE_BLOCK = True
else:
    TILE_BLOCK = False


def new_page(browser, profile, throttle, context=None):
    context = context or browser.new_context(**PROFILES[profile])
    page = context.new_page()
    page.add_init_script(INIT)
    if TILE_BLOCK:
        # Basemap tiles come from a third party and vary run to run; the audit measures the app.
        page.route("**/basemap.nationalmap.gov/**", lambda route: route.abort())
    cdp = context.new_cdp_session(page)
    if throttle == "fast4g":
        cdp.send("Network.enable")
        cdp.send("Network.emulateNetworkConditions", FAST4G)
        cdp.send("Emulation.setCPUThrottlingRate", {"rate": 4})
    return context, page


IDLE = """() => { const p = document.getElementById('progress'), s = document.getElementById('scope');
  return typeof state !== 'undefined' && state.states && (!p || p.hidden) && s && !/^Loading/.test(s.textContent); }"""


def idle(page, timeout=300000):
    page.wait_for_function(IDLE, timeout=timeout, polling=50)
    page.evaluate("() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))")


def snapshot(page):
    return page.evaluate("""() => ({now: performance.now(), heap: performance.memory ? performance.memory.usedJSHeapSize : null,
      res: performance.getEntriesByType('resource').length})""")


def step(page, name, action, results, timeout=300000):
    before = snapshot(page)
    error = ""
    try:
        action()
        idle(page, timeout)
    except Exception as e:  # a broken control is a finding, not a reason to stop the walk
        error = str(e).splitlines()[0][:160]
        page.keyboard.press("Escape")
    after = page.evaluate("""(t0) => {
      const now = performance.now();
      if (window.gc) gc();
      const lt = __audit.longtasks.filter(([s]) => s >= t0);
      const res = performance.getEntriesByType('resource').filter(r => r.startTime >= t0);
      return {now, heap: performance.memory ? performance.memory.usedJSHeapSize : null,
        lt: lt.length, ltTotal: lt.reduce((a, [, d]) => a + d, 0), ltMax: lt.reduce((a, [, d]) => Math.max(a, d), 0),
        bytes: res.reduce((a, r) => a + (r.transferSize || 0), 0), files: res.length};
    }""", before["now"])
    results[name] = {"ms": round(after["now"] - before["now"]), "longtasks": after["lt"], "longtask_ms": round(after["ltTotal"]),
                     "longtask_max": round(after["ltMax"]), "bytes": after["bytes"], "files": after["files"],
                     "heap_mb": round(after["heap"] / 1e6, 1) if after["heap"] else None, "error": error}


def center_of_state(page, code):
    return page.evaluate("""(code) => { let hit; state.states.eachLayer(l => { if (l.feature.properties.code === code) hit = l; });
      const p = map.latLngToContainerPoint(code === 'CA' ? L.latLng(36.5, -119.5) : code === 'TX' ? L.latLng(31.2, -99.3) : hit.getBounds().getCenter());
      const box = map.getContainer().getBoundingClientRect(); return [box.left + p.x, box.top + p.y]; }""", code)


def point_at(page, lat, lng):
    return page.evaluate("""([lat, lng]) => { const p = map.latLngToContainerPoint([lat, lng]); const b = map.getContainer().getBoundingClientRect();
      return [b.left + p.x, b.top + p.y]; }""", [lat, lng])


def click(page, xy, mobile, modifiers=None):
    if mobile and not modifiers:
        page.touchscreen.tap(*xy)
    else:
        for key in modifiers or []:
            page.keyboard.down(key)
        page.mouse.click(*xy)
        for key in modifiers or []:
            page.keyboard.up(key)


def set_select(page, sel, value):
    page.select_option(sel, value)


def set_range(page, sel, value):
    page.evaluate("([s, v]) => { const e = document.querySelector(s); e.value = v; e.dispatchEvent(new Event('input', {bubbles: true})); }", [sel, value])


def toggle_panel(page, panel):
    page.click(f'[data-panel="{panel}"]')


def walkthrough(page, url, mobile):
    """A curious first-time visitor. Returns load metrics and per-step results."""
    r = {}
    t0 = time.time()
    page.goto(url, wait_until="domcontentloaded")
    idle(page)
    load = page.evaluate("""() => { const nav = performance.getEntriesByType('navigation')[0];
      const fcp = performance.getEntriesByName('first-contentful-paint')[0];
      const lt = __audit.longtasks; const ready = performance.now();
      // Time to interactive: after the app is ready, the end of the last long task before a 1 s quiet window.
      let tti = __audit.firstMap || ready;
      for (const [s, d] of lt.slice().sort((a, b) => a[0] - b[0])) { if (s < tti + 1000 && s + d > tti) tti = s + d; }
      return {fcp: fcp ? fcp.startTime : null, first_map: __audit.firstMap, ready, tti: Math.max(tti, ready),
        dcl: nav.domContentLoadedEventEnd, longtasks: lt.length, longtask_ms: lt.reduce((a, [, d]) => a + d, 0),
        longtask_max: lt.reduce((a, [, d]) => Math.max(a, d), 0), heap_mb: (window.gc && gc(), performance.memory.usedJSHeapSize / 1e6),
        resources: performance.getEntriesByType('resource').map(e => ({name: e.name.replace(location.origin, ''), type: e.initiatorType,
          start: Math.round(e.startTime), end: Math.round(e.responseEnd), transfer: e.transferSize, encoded: e.encodedBodySize, decoded: e.decodedBodySize}))}; }""")
    wait = page.wait_for_timeout
    tx = lambda: center_of_state(page, "TX")
    if not mobile:
        step(page, "hover_states", lambda: [page.mouse.move(300 + 90 * i, 350 + 20 * (i % 3), steps=4) for i in range(10)], r)
    step(page, "open_TX_zcta", lambda: click(page, tx(), mobile), r)
    if not mobile:
        step(page, "hover_zips", lambda: [page.mouse.move(*point_at(page, 29.5 + i * .12, -98.8 + i * .12), steps=3) for i in range(20)], r)
    step(page, "click_area", lambda: (click(page, point_at(page, 30.27, -97.74), mobile), wait(600)), r)
    step(page, "dblclick_area_reset", lambda: (page.mouse.dblclick(*point_at(page, 30.27, -97.74)) if not mobile else
                                              (page.touchscreen.tap(*point_at(page, 30.27, -97.74)), page.touchscreen.tap(*point_at(page, 30.27, -97.74)))), r)
    step(page, "reopen_TX", lambda: click(page, tx(), mobile), r)
    step(page, "add_CA", lambda: page.evaluate("chooseState('CA', true)"), r)
    step(page, "remove_CA", lambda: page.evaluate("chooseState('CA', true)"), r)
    for level in ["county", "cd", "cbsa", "cousub", "zcta"]:
        step(page, f"level_{level}", lambda level=level: set_select(page, "#geography", level), r)
    for lo, hi in [(0, 1), (1, 2), (2, 3), (1, 3), (0, 3)]:
        step(page, f"period_{lo}{hi}", lambda lo=lo, hi=hi: (set_range(page, "#period-lo", lo), set_range(page, "#period-hi", hi)), r)
    step(page, "candidate_first", lambda: set_select(page, "#first", "C00369033"), r)
    step(page, "candidate_second", lambda: set_select(page, "#second", "C00919084"), r)
    step(page, "candidate_reset", lambda: (set_select(page, "#second", "C00901918"), set_select(page, "#first", "C00919084")), r)
    for measure in ["volume", "capita", "lead"]:
        step(page, f"measure_{measure}", lambda measure=measure: set_select(page, "#measure", measure), r)
    step(page, "nationwide_county", lambda: (set_select(page, "#geography", "county"), page.click("#nation") if not page.evaluate("state.nationwide") else None), r)
    step(page, "nationwide_zcta", lambda: set_select(page, "#geography", "zcta"), r, timeout=600000)
    step(page, "nationwide_off", lambda: page.click("#home"), r)
    step(page, "open_TX_again", lambda: click(page, tx(), mobile), r)
    step(page, "panel_rank", lambda: toggle_panel(page, "rank"), r)
    for how in ["capita", "first", "avg", "count", "total"]:
        step(page, f"rank_{how}", lambda how=how: set_select(page, "#rank-by", how), r)
    step(page, "rank_level_state", lambda: set_select(page, "#rank-level", "state"), r)
    step(page, "panel_rank_close", lambda: toggle_panel(page, "rank"), r)
    step(page, "panel_filter", lambda: toggle_panel(page, "filter"), r)
    step(page, "filter_min", lambda: set_range(page, "#filter-lo", 500), r)
    step(page, "filter_share", lambda: (page.click('#filter-stat [data-stat="share"]'), set_range(page, "#filter-hi", 400)), r)
    step(page, "panel_filter_close", lambda: toggle_panel(page, "filter"), r)
    step(page, "panel_timeline", lambda: toggle_panel(page, "timeline"), r)
    step(page, "timeline_play", lambda: (page.click("#time-play"), wait(3000), page.click("#time-play")), r)
    step(page, "panel_timeline_close", lambda: toggle_panel(page, "timeline"), r)
    step(page, "panel_donors", lambda: toggle_panel(page, "donors"), r)
    step(page, "panel_donors_close", lambda: toggle_panel(page, "donors"), r)
    step(page, "totals_running", lambda: page.click('#chart-mode [data-mode="cumulative"]') if page.is_visible('#chart-mode') else None, r)
    step(page, "state_picker", lambda: (page.click("#state-picker"), page.fill("#state-search", "new"), page.check('#state-options input[value="NY"]'),
                                       page.click("#state-apply")), r)
    step(page, "about", lambda: (page.click("#about-toggle"), wait(300), page.click("#about-close")), r)
    step(page, "theme_toggle", lambda: (page.click("#theme"), page.click("#theme")), r)
    step(page, "basemap_toggle", lambda: (page.click("#tiles"), page.click("#tiles")), r)
    step(page, "no_receipts_toggle", lambda: (page.click("#empty-toggle"), page.click("#empty-toggle")) if page.is_visible("#empty-toggle") else None, r)
    step(page, "home", lambda: page.click("#home"), r)
    load["walk_seconds"] = round(time.time() - t0, 1)
    load["errors"] = page.evaluate("document.getElementById('error').hidden ? '' : document.getElementById('error').textContent")
    return load, r


def median_of(runs, key):
    vals = [x[key] for x in runs if x.get(key) is not None]
    return statistics.median(vals) if vals else None


def visit(args):
    from playwright.sync_api import sync_playwright
    report = {}
    with sync_playwright() as p:
        browser = chromium(p)
        for profile in args.profiles.split(","):
            for throttle in args.throttle.split(","):
                loads, steps = [], []
                for run in range(args.runs):
                    context, page = new_page(browser, profile, throttle)
                    errors = []
                    page.on("pageerror", lambda e: errors.append(str(e)))
                    load, r = walkthrough(page, args.url, profile == "mobile")
                    load["pageerrors"] = errors
                    loads.append(load)
                    steps.append(r)
                    context.close()
                    print(f"{profile}/{throttle} run {run + 1}: first map {load['first_map']:.0f} ms, ready {load['ready']:.0f} ms, "
                          f"TTI {load['tti']:.0f} ms, walk {load['walk_seconds']} s, errors {errors or load['errors'] or 'none'}", flush=True)
                med = {k: median_of(loads, k) for k in ["fcp", "first_map", "ready", "tti", "longtasks", "longtask_ms", "longtask_max", "heap_mb"]}
                med_steps = {name: {k: median_of([s[name] for s in steps], k) for k in ["ms", "longtasks", "longtask_ms", "longtask_max", "bytes", "files", "heap_mb"]}
                             for name in steps[0]}
                for name in med_steps:
                    med_steps[name]["error"] = next((s[name]["error"] for s in steps if s[name].get("error")), "")
                report[f"{profile}/{throttle}"] = {"load": med, "steps": med_steps, "resources": loads[0]["resources"], "runs": loads}
        browser.close()
    Path(args.out).write_text(json.dumps(report, indent=1))
    print_visit(report)


def print_visit(report):
    for key, data in report.items():
        l = data["load"]
        print(f"\n## {key}  (median)\nFCP {l['fcp']:.0f} ms · first map {l['first_map']:.0f} ms · ready {l['ready']:.0f} ms · TTI {l['tti']:.0f} ms · "
              f"long tasks {l['longtasks']} ({l['longtask_ms']:.0f} ms, max {l['longtask_max']:.0f}) · heap {l['heap_mb']:.0f} MB")
        print("| step | ms | long tasks | long-task ms | max | KB | heap MB |\n|---|---:|---:|---:|---:|---:|---:|")
        for name, s in data["steps"].items():
            print(f"| {name} | {s['ms']:.0f} | {s['longtasks']:.0f} | {s['longtask_ms']:.0f} | {s['longtask_max']:.0f} | {s['bytes'] / 1024:.0f} | {s['heap_mb']} |"
                  + (f" FAILED: {s['error']}" if s.get("error") else ""))


# ---------------------------------------------------------------- repeat visits / cache
def repeat(args):
    """First visit, reload, reload after a redeploy. Point it at `serve --max-age 0` so reloads
    revalidate the way a visit more than ten minutes later does on Pages."""
    from playwright.sync_api import sync_playwright
    out = {}
    with sync_playwright() as p:
        browser = chromium(p)
        context = browser.new_context(**PROFILES["desktop"])
        for label in ["first", "warm", "after_redeploy"]:
            if label == "after_redeploy":
                urllib.request.urlopen(args.url.rstrip("/") + "/__deploy").read()
            _, page = new_page(browser, "desktop", args.throttle, context)
            t0 = time.time()
            page.goto(args.url, wait_until="domcontentloaded")
            idle(page)
            page.evaluate("chooseState('TX', false)")
            idle(page)
            res = page.evaluate("""() => performance.getEntriesByType('resource').map(e => ({name: e.name.replace(location.origin, ''),
              transfer: e.transferSize, status: e.responseStatus}))""")
            out[label] = {"seconds_to_TX": round(time.time() - t0, 2), "bytes": sum(r["transfer"] or 0 for r in res),
                          "geometry_bytes": sum(r["transfer"] or 0 for r in res if ".bin" in r["name"] or "states.json" in r["name"])}
            print(label, out[label], flush=True)
            page.close()
        browser.close()
    if args.out:
        Path(args.out).write_text(json.dumps(out, indent=1))


def nocache(args):
    """Page must still work when Cache Storage throws (private windows, file:// URLs)."""
    from playwright.sync_api import sync_playwright
    with sync_playwright() as p:
        browser = chromium(p)
        context = browser.new_context(**PROFILES["desktop"])
        context.add_init_script("Object.defineProperty(window, 'caches', {get() { throw new DOMException('blocked', 'SecurityError'); }});")
        _, page = new_page(browser, "desktop", "none", context)
        errors = []
        page.on("pageerror", lambda e: errors.append(str(e)))
        page.goto(args.url)
        idle(page)
        page.evaluate("chooseState('TX', false)")
        idle(page)
        n = page.evaluate("state.layer.getLayers().length")
        shown = page.evaluate("document.getElementById('error').hidden ? '' : document.getElementById('error').textContent")
        print(f"Cache Storage unavailable: {n} TX ZCTAs drawn; error panel: {shown or 'none'}; page errors: {errors or 'none'}")
        browser.close()


# ---------------------------------------------------------------- geometry
def geometry_files():
    files = [ROOT / "data/states.json"] + sorted((ROOT / "data/levels/geo").glob("*.bin")) + sorted((ROOT / "data/zctas").glob("*.bin")) + \
        sorted((ROOT / "data/levels/geo/cousub").glob("*.bin"))
    return [f for f in files if f.is_file()]


def static_stats(path):
    raw = path.read_bytes()
    text = gzip.decompress(raw) if path.suffix == ".bin" else raw
    data = json.loads(text)
    vertices = 0

    def walk(c):
        nonlocal vertices
        if isinstance(c[0], (int, float)):
            vertices += 1
        else:
            for x in c:
                walk(x)
    # Typical stored precision: the most common digit count after the point.
    counts = collections.Counter(len(m) for m in re.findall(rb"\.(\d+)", text[:4_000_000]))
    decimals = counts.most_common(1)[0][0] if counts else 0
    props = set()
    for f in data["features"]:
        walk(f["geometry"]["coordinates"])
        props.update(f["properties"])
    return {"file": str(path.relative_to(ROOT)), "wire": len(raw), "json": len(text), "features": len(data["features"]),
            "vertices": vertices, "decimals": decimals, "properties": sorted(props)}


MEASURE_JS = """async (url) => {
  const t0 = performance.now(); const res = await fetch(url, {cache: 'no-store'}); const buf = await res.arrayBuffer(); const t1 = performance.now();
  const stream = url.endsWith('.bin') ? new Blob([buf]).stream().pipeThrough(new DecompressionStream('gzip')) : new Blob([buf]).stream();
  const text = await new Response(stream).text(); const geo = JSON.parse(text); const t2 = performance.now();
  if (window.__layer) __map.removeLayer(__layer);
  const big = geo.features.length > 5000;
  window.__layer = L.geoJSON(geo, big ? {renderer: L.canvas()} : {}).addTo(__map);
  __map.fitBounds(__layer.getBounds());
  await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
  const t3 = performance.now();
  return {fetch: t1 - t0, decode: t2 - t1, draw: t3 - t2, renderer: big ? 'canvas' : 'svg'};
}"""


def geometry(args):
    from playwright.sync_api import sync_playwright
    rows = [static_stats(f) for f in geometry_files()]
    with sync_playwright() as p:
        browser = chromium(p)
        page = browser.new_page(viewport={"width": 1440, "height": 900})
        page.goto(args.url.rstrip("/") + "/vendor/leaflet.css")
        page.set_content(f"""<link rel=stylesheet href="{args.url.rstrip('/')}/vendor/leaflet.css"><div id=m style="width:1440px;height:900px"></div>
          <script src="{args.url.rstrip('/')}/vendor/leaflet.js"></script><script>window.__map = L.map('m', {{zoomSnap: .25}}).setView([37, -96], 4);</script>""")
        page.wait_for_function("window.__map")
        for row in rows:
            times = [page.evaluate(MEASURE_JS, args.url.rstrip("/") + "/" + row["file"]) for _ in range(args.repeat)]
            for key in ["fetch", "decode", "draw"]:
                row[key + "_ms"] = round(statistics.median(t[key] for t in times))
            row["renderer"] = times[0]["renderer"]
        browser.close()
    Path(args.out).write_text(json.dumps(rows, indent=1))
    print("| file | wire KB | JSON KB | features | vertices | decimals | fetch ms | gunzip+parse ms | draw ms |\n|---|---:|---:|---:|---:|---:|---:|---:|---:|")
    for r in rows:
        print(f"| {r['file']} | {r['wire'] / 1024:.0f} | {r['json'] / 1024:.0f} | {r['features']:,} | {r['vertices']:,} | {r['decimals']} | "
              f"{r['fetch_ms']} | {r['decode_ms']} | {r['draw_ms']} ({r['renderer']}) |")
    zc = [r for r in rows if "/zctas/" in r["file"]]
    cs = [r for r in rows if "/cousub/" in r["file"]]
    for name, group in [("zctas", zc), ("cousub", cs)]:
        if group:
            print(f"{name}: {len(group)} files, {sum(r['wire'] for r in group) / 1e6:.1f} MB wire, {sum(r['json'] for r in group) / 1e6:.1f} MB JSON, "
                  f"{sum(r['vertices'] for r in group):,} vertices, decode {sum(r['decode_ms'] for r in group)} ms total")


def headers(args):
    for path in ["", "app.js", "data/states.json", "data/receipts.csv", "data/levels/county.csv", "data/zctas/TX.bin", "data/levels/geo/county.bin", "data/manifest.json"]:
        req = urllib.request.Request(args.url.rstrip("/") + "/" + path, method="HEAD", headers={"Accept-Encoding": "gzip"})
        try:
            with urllib.request.urlopen(req, timeout=30) as r:
                h = r.headers
                print(f"{path or '/'}: {r.status} cache-control={h.get('cache-control')} etag={h.get('etag')} "
                      f"content-encoding={h.get('content-encoding')} last-modified={h.get('last-modified')} length={h.get('content-length')}")
        except Exception as e:
            print(f"{path}: {e}")


# ---------------------------------------------------------------- values
VALUES_JS = """async () => {
  const spans = [[0, 3], [0, 1], [1, 2], [2, 3]], cands = ['C00919084', 'C00369033', 'C00901918'];
  const snap = (store, key) => { const out = {}; for (const sp of spans) { state.span = sp;
    out[sp.join('')] = cands.map(c => values(store, key + '|' + c).map(v => Math.round(v * 100))); } state.span = [0, 3]; return out; };
  const result = {states: {}, zips: {}, levels: {}};
  for (const code of Object.keys(state.statesByCode).sort()) result.states[code] = snap(state.totals, code);
  const wait = () => new Promise(r => { const t = setInterval(() => { const p = document.getElementById('progress');
    if (state.layer && (!p || p.hidden) && !/^Loading/.test(document.getElementById('scope').textContent)) { clearInterval(t); r(); } }, 50); });
  for (const level of ['zcta', 'county', 'cd', 'cbsa', 'cousub']) {
    state.nationwide = false; state.selected = ['TX', 'CA']; setLevel(level); await new Promise(r => setTimeout(r, 100)); await wait();
    const rows = {};
    for (const polygon of state.layer.getLayers()) {
      const {store, key} = areaKey(level, polygon.feature);
      rows[key] = {name: areaTitle(level, polygon.feature), v: snap(store, key)};
    }
    result.levels[level] = rows;
  }
  return result;
}"""


def values_dump(args):
    from playwright.sync_api import sync_playwright
    with sync_playwright() as p:
        browser = chromium(p)
        _, page = new_page(browser, "desktop", "none")
        page.goto(args.url)
        idle(page)
        data = page.evaluate(VALUES_JS)
        browser.close()
    data["levels"] = {k: dict(sorted(v.items())) for k, v in data["levels"].items()}
    Path(args.out).write_text(json.dumps(data, indent=0, sort_keys=True))
    print(args.out, {k: len(v) for k, v in data["levels"].items()}, len(data["states"]), "states")


def main():
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest="cmd", required=True)
    s = sub.add_parser("serve"); s.add_argument("--port", type=int, default=8000); s.add_argument("--deploy", type=int, default=0)
    s.add_argument("--max-age", type=int, default=600)
    v = sub.add_parser("visit"); v.add_argument("url"); v.add_argument("--runs", type=int, default=3)
    v.add_argument("--profiles", default="desktop,mobile"); v.add_argument("--throttle", default="none,fast4g"); v.add_argument("--out", default="audit_visit.json")
    r = sub.add_parser("repeat"); r.add_argument("url"); r.add_argument("--throttle", default="fast4g"); r.add_argument("--out")
    g = sub.add_parser("geometry"); g.add_argument("url"); g.add_argument("--out", default="audit_geometry.json"); g.add_argument("--repeat", type=int, default=3)
    h = sub.add_parser("headers"); h.add_argument("url")
    d = sub.add_parser("values"); d.add_argument("url"); d.add_argument("--out", required=True)
    n = sub.add_parser("nocache"); n.add_argument("url")
    args = ap.parse_args()
    {"serve": serve, "visit": visit, "repeat": repeat, "geometry": geometry, "headers": headers, "values": values_dump, "nocache": nocache}[args.cmd](args)


if __name__ == "__main__":
    main()
