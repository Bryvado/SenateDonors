"""Refresh ZIP aggregates when FEC Form 3 filings are added or amended.

No individual donor records are committed. Report totals must reconcile before
any public file is replaced. Set FEC_API_KEY in GitHub Actions for API access.
"""

import csv
import io
import json
import os
import re
import sys
import tempfile
import time
import urllib.parse
import urllib.request
from collections import defaultdict
from datetime import date, datetime, timezone
from decimal import Decimal, InvalidOperation
from pathlib import Path

CANDIDATES = {"C00919084": "James Talarico", "C00369033": "John Cornyn", "C00901918": "Ken Paxton"}
PHASES = ("pre_primary", "between_primary_runoff", "post_runoff")
HEADER = ("state", "zip", "candidate", "phase", "positive_cents", "net_cents", "count")
MONTH_HEADER = ("state", "candidate", "month", "positive_cents", "net_cents", "count")
START = date(2025, 1, 1)
# Map level -> (HUD crosswalk CSV, pattern a mappable geoid must match).
LEVELS = {"county": ("ZIP-COUNTY.csv", r"\d{5}"), "cd": ("ZIP-CD.csv", r"\d{4}"),
          "cbsa": ("ZIP-CBSA.csv", r"(?!99999)\d{5}"), "cousub": ("ZIP-COUNTY-SUB.csv", r"\d{10}")}
LEVEL_HEADER = ("geoid", "candidate", "phase", "positive_cents", "net_cents", "count")
UNALLOCATED_HEADER = ("level", "state", "candidate", "phase", "positive_cents", "net_cents", "count")
CD_VINTAGE = "119th Congress districts (Census cb_2024_us_cd119_500k), as used by the HUD 06/2026 ZIP-CD crosswalk"


def phase_for(day):
    if day < START:
        return None
    if day <= date(2026, 3, 3):
        return PHASES[0]
    if day <= date(2026, 5, 26):
        return PHASES[1]
    return PHASES[2]


def fetch_json(url):
    with urllib.request.urlopen(urllib.request.Request(url, headers={"User-Agent": "SenateDonors data refresh (public research)"}), timeout=50) as response:
        return json.load(response)


def inventory(key):
    results = {}
    for committee in CANDIDATES:
        page = 1
        reports = []
        while True:
            params = urllib.parse.urlencode({"api_key": key, "committee_id": committee, "cycle": 2026,
                                             "most_recent": "true", "per_page": 100, "page": page})
            result = fetch_json("https://api.open.fec.gov/v1/reports/house-senate/?" + params)
            reports += [r for r in result["results"] if r.get("most_recent") and
                        r.get("means_filed") == "e-file" and r.get("csv_url") and
                        r.get("coverage_end_date") and
                        r["coverage_end_date"][:10] >= START.isoformat()]
            if page >= result["pagination"]["pages"]:
                break
            page += 1
        if not reports:
            raise RuntimeError(f"No electronic reports for {committee}; keeping existing data")
        results[committee] = reports
    return results


def signature(inventories):
    return {committee: sorted(int(report["file_number"]) for report in reports)
            for committee, reports in inventories.items()}


def cents(value):
    return int((Decimal(str(value)) * 100).quantize(Decimal("1")))


def parse_report(report, committee, data, states, transaction_ids, months):
    file_number = report["file_number"]
    expected = cents(report["individual_itemized_contributions_period"])
    url = report["csv_url"]
    if urllib.parse.urlparse(url).hostname != "docquery.fec.gov":
        raise RuntimeError(f"Unexpected FEC CSV host in report {file_number}")
    total = 0
    rows = 0
    # Named temp file limits memory; it is deleted on exit, including exceptions.
    with tempfile.TemporaryFile(mode="w+b") as temp:
        with urllib.request.urlopen(urllib.request.Request(url, headers={"User-Agent": "SenateDonors public data refresh"}), timeout=180) as response:
            while chunk := response.read(1024 * 1024):
                temp.write(chunk)
        temp.seek(0)
        for row in csv.reader(io.TextIOWrapper(temp, encoding="utf-8-sig", errors="replace", newline="")):
            if not row or row[0] != "SA11AI":
                continue
            if len(row) < 43 or row[1] != committee:
                raise RuntimeError(f"Unrecognized SA11AI record in {file_number}")
            if row[42].strip().upper() == "X":
                continue
            try:
                amount = cents(row[20])
            except (InvalidOperation, ValueError) as exc:
                raise RuntimeError(f"Invalid amount in {file_number}") from exc
            total += amount  # Includes non-IND entries to reconcile the FEC report.
            if row[5].strip().upper() != "IND":
                continue
            try:
                day = datetime.strptime(row[19], "%Y%m%d").date()
            except ValueError as exc:
                raise RuntimeError(f"Invalid receipt date in {file_number}") from exc
            phase = phase_for(day)
            if phase is None:
                continue
            transaction_id = row[2].strip()
            if not transaction_id or transaction_id in transaction_ids:
                raise RuntimeError(f"Duplicate/missing transaction ID in {committee}: {transaction_id}")
            transaction_ids.add(transaction_id)
            state = row[15].strip().upper()
            if not re.fullmatch(r"[A-Z]{2}", state):
                continue
            zip5 = row[16].strip()[:5]
            for bucket in (states[state, committee, phase], months[state, committee, day.strftime("%Y-%m")]):
                bucket[0] += max(0, amount)
                bucket[1] += amount
                bucket[2] += amount > 0
            if re.fullmatch(r"\d{5}", zip5):
                bucket = data[state, zip5, committee, phase]
                bucket[0] += max(0, amount)
                bucket[1] += amount
                bucket[2] += amount > 0
            rows += 1
    if total != expected:
        raise RuntimeError(f"Report {file_number} does not reconcile: {total} vs {expected} cents")
    return {"committee": committee, "file_number": int(file_number), "url": url,
            "coverage_end": report["coverage_end_date"][:10], "individual_rows": rows,
            "itemized_cents": total}


def write_data(out, data, states, meta, filings, months=None):
    out.mkdir(parents=True, exist_ok=True)
    outputs = [("receipts.csv", data, HEADER), ("state_totals.csv", states, ("state", "candidate", "phase", *HEADER[-3:]))]
    if months is not None:
        outputs.append(("state_monthly.csv", months, MONTH_HEADER))
    for filename, values, header in outputs:
        with (out / filename).open("w", newline="") as f:
            writer = csv.writer(f)
            writer.writerow(header)
            writer.writerows((*key, *value) for key, value in sorted(values.items()))
    (out / "coverage.json").write_text(json.dumps(meta, indent=2) + "\n")
    (out / "filings.json").write_text(json.dumps(filings, indent=2) + "\n")


def load_crosswalk(path):
    """ZIP -> [(geoid, weight)], weights normalized to sum to 1.

    res_ratio is the weight; a ZIP with no residential addresses (PO box or
    business-only) falls back to tot_ratio.
    """
    rows = defaultdict(list)
    with path.open(newline="") as f:
        for row in csv.DictReader(f):
            rows[row["zip"]].append((row["geoid"], float(row["res_ratio"]), float(row["tot_ratio"])))
    result = {}
    for zip5, items in rows.items():
        column = 1 if sum(item[1] for item in items) > 0 else 2
        total = sum(item[column] for item in items)
        if total > 0:
            result[zip5] = [(item[0], item[column] / total) for item in items if item[column] > 0]
    return result


def split(amount, weights):
    """Split an integer across weights; the rounding remainder goes to the largest share."""
    shares = [round(amount * weight) for weight in weights]
    shares[max(range(len(weights)), key=weights.__getitem__)] += amount - sum(shares)
    return shares


def allocate_levels(receipts_csv, crosswalks, out):
    """Apportion ZIP receipts to each HUD crosswalk geography and write data/levels/*.csv.

    Counts are split in hundredths, so they are written with two decimals.
    Placeholder geoids (containing '*', CBSA 99999, malformed codes) keep their
    dollars in levels/unallocated.csv by reported state.
    """
    with receipts_csv.open(newline="") as f:
        receipts = [(row["state"], row["zip"], row["candidate"], row["phase"],
                     int(row["positive_cents"]), int(row["net_cents"]), round(float(row["count"]) * 100))
                    for row in csv.DictReader(f)]
    out.mkdir(parents=True, exist_ok=True)
    unallocated = defaultdict(lambda: [0, 0, 0])
    for level, (filename, pattern) in LEVELS.items():
        crosswalk = load_crosswalk(crosswalks / filename)
        totals = defaultdict(lambda: [0, 0, 0])
        matched = 0
        for state, zip5, candidate, phase, *values in receipts:
            parts = crosswalk.get(zip5)
            if not parts:
                continue
            matched += values[0]
            splits = [split(value, [weight for _, weight in parts]) for value in values]
            for index, (geoid, _) in enumerate(parts):
                bucket = totals[geoid, candidate, phase] if re.fullmatch(pattern, geoid) else unallocated[level, state, candidate, phase]
                for i in range(3):
                    bucket[i] += splits[i][index]
        placed = sum(value[0] for value in totals.values())
        dropped = sum(value[0] for key, value in unallocated.items() if key[0] == level)
        if placed + dropped != matched:
            raise RuntimeError(f"{level} allocation does not reconcile: {placed} + {dropped} vs {matched} cents")
        with (out / f"{level}.csv").open("w", newline="") as f:
            writer = csv.writer(f)
            writer.writerow(LEVEL_HEADER)
            writer.writerows((*key, value[0], value[1], f"{value[2] / 100:.2f}")
                             for key, value in sorted(totals.items()) if any(value))
        print(level, len(totals), "areas;", placed, "of", matched, "matched cents mapped", flush=True)
    with (out / "unallocated.csv").open("w", newline="") as f:
        writer = csv.writer(f)
        writer.writerow(UNALLOCATED_HEADER)
        writer.writerows((*key, value[0], value[1], f"{value[2] / 100:.2f}")
                         for key, value in sorted(unallocated.items()) if any(value))


LEVEL_FILES = [f"levels/{level}.csv" for level in LEVELS] + ["levels/unallocated.csv"]


def publish(data, states, meta, filings, out, months=None):
    """Stage every output in a temp dir, then replace the tracked files.

    months (state, candidate, YYYY-MM totals) needs receipt dates; seed.py has
    none, so it leaves the existing state_monthly.csv in place.
    """
    meta = {**meta, "cd_vintage": CD_VINTAGE,
            "levels": "ZIP totals apportioned by HUD USPS ZIP crosswalk residential address shares (06/2026)"}
    with tempfile.TemporaryDirectory() as temp:
        staged = Path(temp)
        write_data(staged, data, states, meta, filings, months)
        allocate_levels(staged / "receipts.csv", out / "crosswalks", staged / "levels")
        (out / "levels").mkdir(exist_ok=True)
        monthly = ["state_monthly.csv"] if months is not None else []
        for filename in ("receipts.csv", "state_totals.csv", "coverage.json", "filings.json", *monthly, *LEVEL_FILES):
            os.replace(staged / filename, out / filename)


def rebuild_levels(out):
    """Regenerate only data/levels/*.csv from the current receipts.csv (e.g. after a new HUD quarter)."""
    with tempfile.TemporaryDirectory() as temp:
        allocate_levels(out / "receipts.csv", out / "crosswalks", Path(temp))
        (out / "levels").mkdir(exist_ok=True)
        for filename in LEVEL_FILES:
            os.replace(Path(temp) / filename.split("/")[1], out / filename)


def main():
    out = Path(__file__).resolve().parents[1] / "data"
    if "--levels-only" in sys.argv[1:]:
        rebuild_levels(out)
        return
    key = os.environ.get("FEC_API_KEY") or "DEMO_KEY"
    inventories = inventory(key)
    current = out / "filings.json"
    # A missing state_monthly.csv forces one rebuild even if no filing changed.
    if (current.exists() and (out / "state_monthly.csv").exists()
            and json.loads(current.read_text()).get("committees") == signature(inventories)):
        print("FEC filing inventory unchanged")
        return
    data = defaultdict(lambda: [0, 0, 0])
    states = defaultdict(lambda: [0, 0, 0])
    months = defaultdict(lambda: [0, 0, 0])
    audit = []
    for committee, reports in inventories.items():
        ids = set()
        for report in sorted(reports, key=lambda r: r["file_number"]):
            record = parse_report(report, committee, data, states, ids, months)
            audit.append(record)
            print(committee, record["file_number"], "reconciled", flush=True)
    meta = {"retrieved": datetime.now(timezone.utc).date().isoformat(), "coverage_start": START.isoformat(),
            "coverage_end": max(r["coverage_end"] for r in audit), "filing_count": len(audit),
            "source": "FEC electronic filings", "geography": "Reported contributor state and ZIP matched to 2020 Census ZCTA"}
    # Validate the entire new snapshot before replacing any tracked output.
    publish(data, states, meta, {"committees": signature(inventories), "reports": audit}, out, months)
    print("Published through", meta["coverage_end"])


if __name__ == "__main__":
    main()
