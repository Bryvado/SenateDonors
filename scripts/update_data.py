"""Refresh ZIP aggregates when FEC Form 3 filings are added or amended.

No individual donor records are committed. Report totals must reconcile before
any public file is replaced. Set FEC_API_KEY in GitHub Actions for API access.
"""

import csv
import io
import json
import os
import re
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
START = date(2025, 1, 1)


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


def parse_report(report, committee, data, states, transaction_ids):
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
            key = (state, committee, phase)
            bucket = states[key]
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


def write_data(out, data, states, meta, filings):
    out.mkdir(parents=True, exist_ok=True)
    for filename, values in (("receipts.csv", data), ("state_totals.csv", states)):
        with (out / filename).open("w", newline="") as f:
            writer = csv.writer(f)
            writer.writerow(HEADER if filename == "receipts.csv" else ("state", "candidate", "phase", *HEADER[-3:]))
            writer.writerows((*key, *value) for key, value in sorted(values.items()))
    (out / "coverage.json").write_text(json.dumps(meta, indent=2) + "\n")
    (out / "filings.json").write_text(json.dumps(filings, indent=2) + "\n")


def main():
    out = Path(__file__).resolve().parents[1] / "data"
    key = os.environ.get("FEC_API_KEY") or "DEMO_KEY"
    inventories = inventory(key)
    current = out / "filings.json"
    if current.exists() and json.loads(current.read_text()).get("committees") == signature(inventories):
        print("FEC filing inventory unchanged")
        return
    data = defaultdict(lambda: [0, 0, 0])
    states = defaultdict(lambda: [0, 0, 0])
    audit = []
    for committee, reports in inventories.items():
        ids = set()
        for report in sorted(reports, key=lambda r: r["file_number"]):
            record = parse_report(report, committee, data, states, ids)
            audit.append(record)
            print(committee, record["file_number"], "reconciled", flush=True)
    meta = {"retrieved": datetime.now(timezone.utc).date().isoformat(), "coverage_start": START.isoformat(),
            "coverage_end": max(r["coverage_end"] for r in audit), "filing_count": len(audit),
            "source": "FEC electronic filings", "geography": "Reported contributor state and ZIP matched to 2020 Census ZCTA"}
    # Validate the entire new snapshot before replacing any tracked output.
    with tempfile.TemporaryDirectory() as temp:
        staged = Path(temp)
        write_data(staged, data, states, meta, {"committees": signature(inventories), "reports": audit})
        for filename in ("receipts.csv", "state_totals.csv", "coverage.json", "filings.json"):
            os.replace(staged / filename, out / filename)
    print("Published through", meta["coverage_end"])


if __name__ == "__main__":
    main()
