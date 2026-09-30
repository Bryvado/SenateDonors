"""Census batch geocoding with a local cache. Standard library only.

Addresses exist only in memory, in the request bodies sent to the Census geocoder,
and (hashed) in the cache file. The cache maps sha256(normalized address) to the
2020 tabulation block GEOID it matched ("" for no match or a tie), so the file holds
no address text; it is still address-derived, so it is never committed. In GitHub
Actions it is carried between runs with actions/cache (see site.yml).

Benchmark Public_AR_Current, vintage Census2020_Current: blocks come back with 2020
codes, the keys of the block lookups in data/lookups/ (119th Congress BEF, 2020 PL
94-171 county subdivisions).
"""

import concurrent.futures
import csv
import gzip
import hashlib
import io
import json
import os
import re
import time
import urllib.request
import uuid
from pathlib import Path

URL = "https://geocoding.geo.census.gov/geocoder/geographies/addressbatch"
BENCHMARK, VINTAGE = "Public_AR_Current", "Census2020_Current"
BATCH = 10_000  # the service's per-request maximum
WORKERS = 3
ATTEMPTS = 4
# PO boxes, rural route boxes and similar cannot be placed at a street address.
UNPLACEABLE = re.compile(r"\b(P\s*\.?\s*O\s*\.?\s*(BOX|BX|B)|POST\s+OFFICE\s+BOX|BOX|PMB|RR|RURAL\s+ROUTE|HC)\s*#?\s*\d", re.I)
DEFAULT_CACHE = Path(__file__).resolve().parents[1] / ".cache" / "geocode.json.gz"


def normalize(street1, street2, city, state, zip5):
    """(street, city, state, zip5) in upper case with collapsed spaces, or None if it cannot be geocoded."""
    street = " ".join(f"{street1} {street2}".upper().replace(",", " ").replace('"', " ").split())
    city = " ".join(city.upper().replace(",", " ").replace('"', " ").split())
    if not street or not re.fullmatch(r"\d{5}", zip5) or UNPLACEABLE.search(street) or not re.search(r"\d", street):
        return None
    return street, city, state, zip5


def address_key(address):
    return hashlib.sha256("|".join(address).encode()).hexdigest()[:24]


def load_cache(path):
    try:
        with gzip.open(path, "rt") as f:
            data = json.load(f)
        return data if data.get("benchmark") == BENCHMARK and data.get("vintage") == VINTAGE else {"results": {}}
    except (OSError, ValueError):
        return {"results": {}}


def save_cache(path, results):
    path.parent.mkdir(parents=True, exist_ok=True)
    temp = path.with_suffix(".tmp")
    with gzip.open(temp, "wt") as f:
        json.dump({"benchmark": BENCHMARK, "vintage": VINTAGE, "results": results}, f, separators=(",", ":"))
    os.replace(temp, path)


def request_batch(rows):
    """POST one batch; returns {key: block GEOID or ""}. Raises on transport errors."""
    body = io.StringIO()
    csv.writer(body, lineterminator="\n").writerows(rows)
    boundary = uuid.uuid4().hex
    parts = []
    for name, value in (("benchmark", BENCHMARK), ("vintage", VINTAGE)):
        parts.append(f'--{boundary}\r\nContent-Disposition: form-data; name="{name}"\r\n\r\n{value}\r\n')
    parts.append(f'--{boundary}\r\nContent-Disposition: form-data; name="addressFile"; filename="addresses.csv"\r\n'
                 f"Content-Type: text/csv\r\n\r\n{body.getvalue()}\r\n--{boundary}--\r\n")
    request = urllib.request.Request(URL, data="".join(parts).encode(), method="POST",
                                     headers={"Content-Type": f"multipart/form-data; boundary={boundary}",
                                              "User-Agent": "SenateDonors data refresh (public research)"})
    with urllib.request.urlopen(request, timeout=900) as response:
        text = response.read().decode("utf-8", "replace")
    results = {}
    for row in csv.reader(io.StringIO(text)):
        if len(row) < 3 or row[0] == "":
            continue
        block = ""
        if row[2] == "Match" and len(row) >= 12 and all(row[8:12]):
            block = row[8] + row[9] + row[10] + row[11]
            if not re.fullmatch(r"\d{15}", block):
                block = ""
        results[row[0]] = block
    sent = {row[0] for row in rows}
    if len(set(results) & sent) < 0.9 * len(sent):
        raise RuntimeError(f"Geocoder returned {len(results)} of {len(sent)} rows")
    return {key: results.get(key, "") for key in sent}


def with_retries(rows):
    for attempt in range(ATTEMPTS):
        try:
            return request_batch(rows)
        except Exception as exc:  # network, HTTP 5xx, malformed reply
            wait = 30 * 2 ** attempt
            print(f"geocoder batch of {len(rows)} failed ({exc}); retry in {wait}s" if attempt + 1 < ATTEMPTS
                  else f"geocoder batch of {len(rows)} failed ({exc}); giving up for this run", flush=True)
            if attempt + 1 < ATTEMPTS:
                time.sleep(wait)
    return None


def geocode(addresses, cache_path=None, budget_seconds=None):
    """{address: block GEOID or ""} for cached or newly geocoded addresses.

    Addresses the geocoder could not answer this run (service down, time budget
    spent) are missing from the result; callers fall back to the ZIP split for them.
    Never raises because of the geocoder.
    """
    cache_path = Path(cache_path or os.environ.get("GEOCODE_CACHE") or DEFAULT_CACHE)
    budget = budget_seconds if budget_seconds is not None else float(os.environ.get("GEOCODE_BUDGET_MIN", "120")) * 60
    cache = load_cache(cache_path)["results"]
    keys = {address: address_key(address) for address in addresses}
    todo = sorted({key: address for address, key in keys.items() if key not in cache}.items())
    print(f"geocode: {len(keys)} addresses, {len(keys) - len(todo)} cached, {len(todo)} to request", flush=True)
    started = time.monotonic()
    batches = [todo[i:i + BATCH] for i in range(0, len(todo), BATCH)]
    with concurrent.futures.ThreadPoolExecutor(WORKERS) as pool:
        pending = {}
        for batch in batches:
            if time.monotonic() - started > budget:
                print("geocode: time budget spent; remaining addresses use the ZIP split this run", flush=True)
                break
            rows = [(key, *address[:3], address[3]) for key, address in batch]
            pending[pool.submit(with_retries, rows)] = len(rows)
            # Keep at most WORKERS requests in flight so the budget check stays meaningful.
            while len(pending) >= WORKERS:
                done, _ = concurrent.futures.wait(pending, return_when=concurrent.futures.FIRST_COMPLETED)
                for future in done:
                    pending.pop(future)
                    if future.result():
                        cache.update(future.result())
                save_cache(cache_path, cache)
        for future in concurrent.futures.as_completed(pending):
            if future.result():
                cache.update(future.result())
    save_cache(cache_path, cache)
    found = {address: cache[key] for address, key in keys.items() if key in cache}
    print(f"geocode: {sum(1 for v in found.values() if v)} matched, {sum(1 for v in found.values() if not v)} "
          f"unmatched, {len(keys) - len(found)} not answered in {time.monotonic() - started:.0f}s", flush=True)
    return found
