"""Block -> map area lookups for geocoded contributions. Standard library only.

The tables in data/lookups/ are built by scripts/build_lookups.py and match the
polygons the map draws: 119th Congress districts (cb_2024_us_cd119), cb_2022 county
subdivisions, cb_2024 counties (Connecticut planning regions) and cb_2024 CBSAs
(July 2023 delineation).
"""

import bisect
import csv
import gzip
from pathlib import Path

LOOKUPS = Path(__file__).resolve().parents[1] / "data" / "lookups"


class Runs:
    """Run-length table over sorted 15-digit block GEOIDs (see build_lookups.py)."""

    def __init__(self, path):
        with gzip.open(path, "rt", newline="") as f:
            rows = list(csv.reader(f))[1:]
        self.starts = [row[0] for row in rows]
        self.values = [row[1] for row in rows]

    def get(self, block):
        index = bisect.bisect_right(self.starts, block) - 1
        return self.values[index] if index >= 0 else ""


class Placer:
    def __init__(self, lookups=LOOKUPS):
        self.cd = Runs(lookups / "block_cd.csv.gz")
        self.cousub = Runs(lookups / "block_cousub.csv.gz")
        with (lookups / "county_cbsa.csv").open(newline="") as f:
            self.cbsa = {row["county"]: row["cbsa"] for row in csv.DictReader(f)}

    def areas(self, block):
        """{level: geoid, or None when the block cannot be placed at that level}.

        A county outside every CBSA is placed as "" (known, but not in a metro or
        micro area), which the allocation treats like HUD's non-metro code 99999.
        """
        cousub = self.cousub.get(block) or None
        if cousub:
            county = cousub[:5]
        elif block[:2] != "09":  # Connecticut counties changed; its county comes only from the town
            county = block[:5]
        else:
            county = None
        return {"county": county, "cd": self.cd.get(block) or None, "cousub": cousub,
                "cbsa": None if county is None else self.cbsa.get(county, "")}
