"""Convert the audited September 2026 FEC bundle into public map aggregates."""

import argparse
import csv
import json
from collections import defaultdict
from decimal import Decimal
from pathlib import Path

from update_data import write_data, CANDIDATES, PHASES


def main():
    p = argparse.ArgumentParser()
    p.add_argument("bundle", type=Path)
    p.add_argument("--out", type=Path, default=Path("data"))
    args = p.parse_args()
    data = defaultdict(lambda: [0, 0, 0])
    states = defaultdict(lambda: [0, 0, 0])
    with (args.bundle / "zip_contributions_long.csv").open(newline="") as f:
        for row in csv.DictReader(f):
            if row["split_scheme"] != "three_phase":
                continue
            candidate = next(code for code, name in CANDIDATES.items() if name == row["candidate"])
            state, zip5, phase = row["state"], row["zip5"], row["period"]
            if not state or phase not in PHASES:
                continue
            values = [
                int(Decimal(row["positive_receipts"]) * 100),
                int(Decimal(row["itemized_receipts_signed"]) * 100),
                int(row["positive_contribution_count"]),
            ]
            for index in range(3):
                states[state, candidate, phase][index] += values[index]
                if len(zip5) == 5 and zip5.isdigit():
                    data[state, zip5, candidate, phase][index] += values[index]
    with (args.bundle / "filing_audit.csv").open(newline="") as f:
        reports = list(csv.DictReader(f))
    filings = {
        "committees": {code: sorted(int(row["file_number"]) for row in reports if row["committee_id"] == code)
                       for code in CANDIDATES},
        "reports": [{"committee": row["committee_id"], "file_number": int(row["file_number"]),
                     "url": row["source_url"], "coverage_end": row["coverage_end"]} for row in reports],
    }
    meta = {
        "retrieved": "2026-09-24", "coverage_start": "2025-01-01", "coverage_end": "2026-06-30",
        "filing_count": len(reports), "source": "Audited FEC electronic filings",
        "geography": "Reported contributor state and ZIP matched to 2020 Census ZCTA",
    }
    write_data(args.out, data, states, meta, filings)
    print(len(data), "state-ZIP-candidate-period groups", len(reports), "filings")


if __name__ == "__main__":
    main()
