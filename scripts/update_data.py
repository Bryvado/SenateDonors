"""Refresh ZIP aggregates when FEC Form 3 filings are added or amended.

No individual donor records are committed. Report totals must reconcile before
any public file is replaced. Set FEC_API_KEY in GitHub Actions for API access.

Contributor names and street addresses are read into memory only: addresses are
geocoded (scripts/geocode.py, cache kept outside git) to place each contribution in
its county, congressional district, CBSA and county subdivision, and names form the
donor keys for the max-out counts (scripts/maxouts.py). Only aggregates are written.
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

import geocode
import maxouts
from placement import Placer

CANDIDATES = {"C00919084": "James Talarico", "C00369033": "John Cornyn", "C00901918": "Ken Paxton"}
PHASES = ("pre_primary", "between_primary_runoff", "post_runoff")
HEADER = ("state", "zip", "candidate", "phase", "positive_cents", "net_cents", "count")
MONTH_HEADER = ("state", "candidate", "month", "positive_cents", "net_cents", "count")
START = date(2025, 1, 1)
# Map level -> (HUD crosswalk CSV, pattern a mappable geoid must match).
LEVELS = {"county": ("ZIP-COUNTY.csv", r"\d{5}"), "cd": ("ZIP-CD.csv", r"\d{4}"),
          "cbsa": ("ZIP-CBSA.csv", r"(?!99999)\d{5}"), "cousub": ("ZIP-COUNTY-SUB.csv", r"\d{10}")}
LEVEL_HEADER = ("geoid", "candidate", "phase", "positive_cents", "net_cents", "count", "address_cents", "address_count")
MAXOUT_HEADER = ("state", "zip", "candidate", "election", "single_gift", "accumulated", "over_limit_contributions")
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


def optional_cents(value):
    try:
        return cents(value) if value.strip() else None
    except (InvalidOperation, ValueError):
        return None


def contributor(row, committee, report, state, zip5, day, amount):
    """The in-memory record of one Schedule A row. FEC v8 Schedule A: 3 back-reference transaction
    ID, 7-11 name parts, 12-13 street, 14 city, 15 state, 16 ZIP, 17 election code, 18 election
    description, 21 election-to-date aggregate, 43 memo text."""
    return {"committee": committee, "tid": row[2].strip(), "state": state,
            "zip": zip5 if re.fullmatch(r"\d{5}", zip5) else "", "phase": phase_for(day), "day": day,
            "amount": amount, "address": geocode.normalize(row[12], row[13], row[14], state, zip5),
            "coded": maxouts.coded_election(row[17], row[18]),
            "key": maxouts.donor_key(row[7], row[8], zip5), "aggregate": optional_cents(row[21]),
            "period_end": report["coverage_end_date"][:10]}


def memo_adjustment(row, committee, report):
    """A memo row that redesignates or reattributes an individual's gift, else None."""
    if row[5].strip().upper() != "IND" or not maxouts.ADJUSTMENT.search(row[43] if len(row) > 43 else ""):
        return None
    try:
        day, amount = datetime.strptime(row[19], "%Y%m%d").date(), cents(row[20])
    except (ValueError, InvalidOperation):
        return None
    state = row[15].strip().upper()
    if phase_for(day) is None or not re.fullmatch(r"[A-Z]{2}", state):
        return None
    record = contributor(row, committee, report, state, row[16].strip()[:5], day, amount)
    record.update(adjust=True, parent=row[3].strip() or None)
    return record


def parse_report(report, committee, data, states, transaction_ids, months, contributions=None):
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
                # Memo rows are not receipts, but redesignations and reattributions move a gift's
                # dollars between elections or to a spouse; the max-out counts apply them.
                if contributions is not None:
                    adjustment = memo_adjustment(row, committee, report)
                    if adjustment:
                        contributions.append(adjustment)
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
            if contributions is not None:
                contributions.append(contributor(row, committee, report, state, zip5, day, amount))
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


def place(contributions, placer):
    """Attach each contribution's map areas: {level: geoid, "" (no CBSA), or None (use the ZIP split)}."""
    for c in contributions:
        block = c.get("block")
        c["areas"] = placer.areas(block) if block else {}


def allocate_levels(receipts_csv, crosswalks, out, contributions=None):
    """Write data/levels/{level}.csv and unallocated.csv; return placement stats per level.

    Contributions placed by geocoded address go whole to their area (address_cents and
    address_count record their positive dollars and whole count). The rest of each ZIP's total is apportioned by the
    HUD crosswalk, with counts split in hundredths, so counts have two decimals. Only
    ZIPs in a crosswalk count toward a level, whether or not their addresses geocode,
    so level totals are the same with or without placement. Placeholder geoids
    (containing '*', CBSA 99999 or no CBSA, malformed codes) keep their dollars in
    levels/unallocated.csv by reported state.
    """
    with receipts_csv.open(newline="") as f:
        receipts = [(row["state"], row["zip"], row["candidate"], row["phase"],
                     int(row["positive_cents"]), int(row["net_cents"]), round(float(row["count"]) * 100))
                    for row in csv.DictReader(f)]
    out.mkdir(parents=True, exist_ok=True)
    unallocated = defaultdict(lambda: [0, 0, 0])
    stats = {}
    for level, (filename, pattern) in LEVELS.items():
        crosswalk = load_crosswalk(crosswalks / filename)
        placed = defaultdict(list)
        for c in contributions or ():
            if c.get("adjust"):
                continue
            geoid = c["areas"].get(level)
            if geoid is not None and c["zip"]:
                placed[c["state"], c["zip"], c["committee"], c["phase"]].append(
                    (geoid, max(0, c["amount"]), c["amount"], 100 if c["amount"] > 0 else 0))
        # positive, net, count x100, then the positive cents and count placed by address
        totals = defaultdict(lambda: [0, 0, 0, 0, 0])
        matched = by_address = 0
        for state, zip5, candidate, phase, *values in receipts:
            parts = crosswalk.get(zip5)
            if not parts:
                continue
            matched += values[0]
            rest = list(values)
            for geoid, *amounts in placed.get((state, zip5, candidate, phase), ()):
                known = bool(geoid) and re.fullmatch(pattern, geoid)
                bucket = totals[geoid, candidate, phase] if known else unallocated[level, state, candidate, phase]
                for i in range(3):
                    bucket[i] += amounts[i]
                    rest[i] -= amounts[i]
                if known:
                    bucket[3] += amounts[0]
                    bucket[4] += amounts[2] // 100
                by_address += amounts[0]
            splits = [split(value, [weight for _, weight in parts]) for value in rest]
            for index, (geoid, _) in enumerate(parts):
                bucket = totals[geoid, candidate, phase] if re.fullmatch(pattern, geoid) else unallocated[level, state, candidate, phase]
                for i in range(3):
                    bucket[i] += splits[i][index]
        mapped = sum(value[0] for value in totals.values())
        dropped = sum(value[0] for key, value in unallocated.items() if key[0] == level)
        if mapped + dropped != matched:
            raise RuntimeError(f"{level} allocation does not reconcile: {mapped} + {dropped} vs {matched} cents")
        with (out / f"{level}.csv").open("w", newline="") as f:
            writer = csv.writer(f)
            writer.writerow(LEVEL_HEADER)
            writer.writerows((*key, value[0], value[1], f"{value[2] / 100:.2f}", value[3], value[4])
                             for key, value in sorted(totals.items()) if any(value))
        stats[level] = {"matched_cents": matched, "address_cents": by_address,
                        "mapped_address_cents": sum(value[3] for value in totals.values()), "unallocated_cents": dropped}
        print(level, len(totals), "areas;", mapped, "of", matched, "matched cents mapped;",
              by_address, "placed by address", flush=True)
    with (out / "unallocated.csv").open("w", newline="") as f:
        writer = csv.writer(f)
        writer.writerow(UNALLOCATED_HEADER)
        writer.writerows((*key, value[0], value[1], f"{value[2] / 100:.2f}")
                         for key, value in sorted(unallocated.items()) if any(value))
    return stats


def write_maxouts(contributions, crosswalks, out):
    """Count donors who reached the limit; write maxouts.csv and levels/maxouts_*.csv. Returns a summary.

    Each max-out donor-election is placed where its most recent contribution for that
    election was: reported state and ZIP for maxouts.csv, and the geocoded address (or
    the ZIP's HUD split, in hundredths of a donor) for each level.
    """
    runoffs = maxouts.runoff_committees(contributions)
    groups = maxouts.donor_groups(contributions, runoffs)
    by_zip = defaultdict(lambda: [0, 0, 0])
    by_level = {level: defaultdict(lambda: [0, 0, 0]) for level in LEVELS}
    unallocated = defaultdict(lambda: [0, 0, 0])
    summary = defaultdict(lambda: [0, 0, 0])
    net_below = defaultdict(int)
    near = defaultdict(int)
    crosswalk = {level: load_crosswalk(crosswalks / filename) for level, (filename, _) in LEVELS.items()}
    for (committee, election, _), rows in groups.items():
        kind, over = maxouts.maxout(rows)
        near[committee, election] += maxouts.near_limit(rows)
        if kind is None and not over:
            continue
        counts = [kind == "single_gift", kind == "accumulated", over]
        if kind and sum(c["amount"] for c in rows if not c.get("adjust")) + sum(
                c["amount"] for c in rows if c.get("adjust")) < maxouts.LIMIT_CENTS:
            net_below[committee] += 1  # reached the limit in positive receipts, but negative adjustments bring it under
        last = rows[-1]
        for i in range(3):
            by_zip[last["state"], last["zip"], committee, election][i] += counts[i]
            summary[committee, election][i] += counts[i]
        for level, (_, pattern) in LEVELS.items():
            geoid = last["areas"].get(level)
            if geoid is not None:
                parts = [(geoid, 1.0)]
            elif last["zip"] in crosswalk[level]:
                parts = crosswalk[level][last["zip"]]
            else:
                continue
            splits = [split(value * 100, [weight for _, weight in parts]) for value in counts]
            for index, (area, _) in enumerate(parts):
                bucket = (by_level[level][area, committee, election] if area and re.fullmatch(pattern, area)
                          else unallocated[level, last["state"], committee, election])
                for i in range(3):
                    bucket[i] += splits[i][index]
    with (out / "maxouts.csv").open("w", newline="") as f:
        writer = csv.writer(f)
        writer.writerow(MAXOUT_HEADER)
        writer.writerows((*key, *value) for key, value in sorted(by_zip.items()))
    for level, values in by_level.items():
        with (out / "levels" / f"maxouts_{level}.csv").open("w", newline="") as f:
            writer = csv.writer(f)
            writer.writerow(("geoid", *MAXOUT_HEADER[2:]))
            writer.writerows((*key, *(f"{v / 100:.2f}" for v in value)) for key, value in sorted(values.items()) if any(value))
    with (out / "levels" / "maxouts_unallocated.csv").open("w", newline="") as f:
        writer = csv.writer(f)
        writer.writerow(("level", "state", *MAXOUT_HEADER[2:]))
        writer.writerows((*key, *(f"{v / 100:.2f}" for v in value))
                         for key, value in sorted(unallocated.items()) if any(value))
    check = maxouts.aggregate_check(groups)
    print("max-out donors:", {f"{k[0]}|{k[1]}": v for k, v in sorted(summary.items())}, flush=True)
    print("aggregate check:", check["agree"], "of", check["groups"], "donor-elections match column 21", flush=True)
    return {"limit_cents": maxouts.LIMIT_CENTS, "limit_cycle": maxouts.LIMIT_CYCLE, "limit_source": maxouts.LIMIT_SOURCE,
            "runoff_committees": sorted(runoffs),
            "runoff_designated_without_runoff": {committee: sum(1 for c in contributions if c["committee"] == committee
                                                                and not c.get("adjust") and c["coded"] == ("runoff", "2026"))
                                                 for committee in CANDIDATES if committee not in runoffs},
            "maxed_out_but_net_below_limit": dict(sorted(net_below.items())),
            # Itemized total $3,300-$3,499.99: unitemized receipts (not in FEC itemizations) could put
            # these at the limit, so the counts are a floor. Not estimated per donor.
            "near_limit": {f"{committee}|{election}": count for (committee, election), count in sorted(near.items()) if count},
            "adjustments": {"memo_rows_applied": sum(1 for rows in groups.values() for c in rows if c.get("adjust")),
                            "rule": "redesignation and reattribution memo rows applied per donor and election"},
            "totals": {f"{committee}|{election}": dict(zip(MAXOUT_HEADER[4:], value))
                       for (committee, election), value in sorted(summary.items())},
            "aggregate_check": {k: check[k] for k in ("groups", "agree", "disagree", "causes")}}


LEVEL_FILES = [f"levels/{level}.csv" for level in LEVELS] + ["levels/unallocated.csv"]
MAXOUT_FILES = ["maxouts.csv"] + [f"levels/maxouts_{level}.csv" for level in LEVELS] + ["levels/maxouts_unallocated.csv"]


def geocode_contributions(contributions):
    """Geocode unique addresses; set c["block"] (None when not placed). Returns match stats."""
    found = geocode.geocode({c["address"] for c in contributions if c["address"]})
    stats = defaultdict(lambda: [0, 0])  # candidate -> [positive cents by address, positive cents]
    by_state = defaultdict(lambda: [0, 0])
    for c in contributions:
        c["block"] = found.get(c["address"]) or None if c["address"] else None
        if c.get("adjust"):
            continue
        amount = max(0, c["amount"])
        for bucket in (stats[c["committee"]], by_state[c["state"]]):
            bucket[1] += amount
            bucket[0] += amount if c["block"] else 0
    pending = len({c["address"] for c in contributions if c["address"] and c["address"] not in found})
    return {"benchmark": geocode.BENCHMARK, "vintage": geocode.VINTAGE, "pending_addresses": pending,
            "addresses": len({c["address"] for c in contributions if c["address"]}),
            "matched_addresses": sum(1 for v in found.values() if v),
            "dollar_match_rate_by_candidate": {k: round(v[0] / v[1], 4) if v[1] else 0 for k, v in sorted(stats.items())},
            "dollar_match_rate_by_state": {k: round(v[0] / v[1], 4) if v[1] else 0 for k, v in sorted(by_state.items())}}


def publish(data, states, meta, filings, out, months=None, contributions=None):
    """Stage every output in a temp dir, then replace the tracked files.

    months (state, candidate, YYYY-MM totals) needs receipt dates, and contributions
    (the in-memory rows, for address placement and max-out counts) need the FEC
    filings; seed.py has neither, so it leaves state_monthly.csv and the max-out files
    alone and apportions every level by the HUD split.
    """
    meta = {**meta, "cd_vintage": CD_VINTAGE,
            "levels": "Contributions placed by geocoded address where possible; the rest of each ZIP's total "
                      "apportioned by HUD USPS ZIP crosswalk residential address shares (06/2026)"}
    with tempfile.TemporaryDirectory() as temp:
        staged = Path(temp)
        (staged / "levels").mkdir()
        if contributions is not None:
            meta["geocode"] = geocode_contributions(contributions)
            place(contributions, Placer())
        write_data(staged, data, states, meta, filings, months)
        meta["placement"] = allocate_levels(staged / "receipts.csv", out / "crosswalks", staged / "levels", contributions)
        files = ["receipts.csv", "state_totals.csv", "filings.json", *LEVEL_FILES]
        if contributions is not None:
            meta["maxouts"] = write_maxouts(contributions, out / "crosswalks", staged)
            files += MAXOUT_FILES
        if months is not None:
            files.append("state_monthly.csv")
        (staged / "coverage.json").write_text(json.dumps(meta, indent=2) + "\n")
        files.append("coverage.json")
        (out / "levels").mkdir(exist_ok=True)
        for filename in files:
            os.replace(staged / filename, out / filename)


def needs_rebuild(out, inventories):
    """True unless the filing inventory is unchanged and the last run finished everything."""
    current = out / "filings.json"
    if not current.exists() or json.loads(current.read_text()).get("committees") != signature(inventories):
        return True
    if not (out / "state_monthly.csv").exists() or not (out / "maxouts.csv").exists():
        return True
    # Addresses the geocoder did not answer last time were split by ZIP; try them again.
    try:
        coverage = json.loads((out / "coverage.json").read_text())
    except (OSError, ValueError):
        return True
    return coverage.get("geocode", {}).get("pending_addresses", 1) > 0


def main():
    out = Path(__file__).resolve().parents[1] / "data"
    # --rebuild (formerly --levels-only) re-reads every filing even if nothing changed,
    # e.g. after a new HUD quarter or new lookups: placement needs the raw rows.
    force = bool({"--rebuild", "--levels-only"} & set(sys.argv[1:]))
    key = os.environ.get("FEC_API_KEY") or "DEMO_KEY"
    inventories = inventory(key)
    if not force and not needs_rebuild(out, inventories):
        print("FEC filing inventory unchanged")
        return
    data = defaultdict(lambda: [0, 0, 0])
    states = defaultdict(lambda: [0, 0, 0])
    months = defaultdict(lambda: [0, 0, 0])
    contributions = []
    audit = []
    for committee, reports in inventories.items():
        ids = set()
        for report in sorted(reports, key=lambda r: r["file_number"]):
            record = parse_report(report, committee, data, states, ids, months, contributions)
            audit.append(record)
            print(committee, record["file_number"], "reconciled", flush=True)
    meta = {"retrieved": datetime.now(timezone.utc).date().isoformat(), "coverage_start": START.isoformat(),
            "coverage_end": max(r["coverage_end"] for r in audit), "filing_count": len(audit),
            "source": "FEC electronic filings", "geography": "Reported contributor state and ZIP matched to 2020 Census ZCTA"}
    # Validate the entire new snapshot before replacing any tracked output.
    publish(data, states, meta, {"committees": signature(inventories), "reports": audit}, out, months, contributions)
    print("Published through", meta["coverage_end"])


if __name__ == "__main__":
    main()
