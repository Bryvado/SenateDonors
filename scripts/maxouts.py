"""Donors who reach the FEC individual contribution limit. Standard library only.

Nothing here is written to disk: donor keys and per-donor sums exist only in memory
while update_data.py runs; only counts by area are published.
"""

import re
from collections import defaultdict
from datetime import date

# FEC contribution limits for 2025-2026 federal elections (Contribution limits chart,
# issued January 2025): an individual may give $3,500 per election to a candidate
# committee. Indexed for inflation in odd-numbered years; update for 2027-2028.
LIMIT_CENTS = 350_000
LIMIT_CYCLE = "2025-2026"
LIMIT_SOURCE = "FEC contribution limits for 2025-2026 federal elections (issued January 2025)"

ELECTIONS = ("primary", "runoff", "general")
# 2026 Texas election dates: an undesignated contribution counts toward the next
# election after its date (11 CFR 110.1(b)(2)(ii)).
ELECTION_DAYS = {"primary": date(2026, 3, 3), "runoff": date(2026, 5, 26), "general": date(2026, 11, 3)}
SUFFIXES = {"JR", "SR", "II", "III", "IV", "V", "MD", "PHD", "ESQ", "DDS", "DVM"}


def coded_election(code, description):
    """Election named by FEC columns 17 and 18, or None when undesignated.

    P/R/G + year are the primary, runoff and general. Filers also use O ("other")
    with a runoff description. Returns ("other", year) for anything else.
    """
    code = code.strip().upper()
    if not code:
        return None
    kind, year = code[:1], code[1:]
    if kind == "P":
        return "primary", year
    if kind == "R" or (kind == "O" and "RUN" in description.upper()):
        return "runoff", year
    if kind == "G":
        return "general", year
    return "other", year


def runoff_committees(contributions):
    """Committees that had a 2026 runoff: they received runoff-designated money after the primary.

    Committees also accept runoff-designated gifts before the primary in case there is a
    runoff; a candidate who wins the primary outright must refund or redesignate them, so
    those alone do not show a runoff happened.
    """
    return {c["committee"] for c in contributions
            if c["coded"] == ("runoff", "2026") and c["day"] > ELECTION_DAYS["primary"]}


def resolve(contribution, runoffs):
    """The election a contribution counts toward, or None if it is not a 2026 P/R/G election."""
    coded = contribution["coded"]
    if coded is None:
        for election in ELECTIONS:
            if election == "runoff" and contribution["committee"] not in runoffs:
                continue
            if contribution["day"] <= ELECTION_DAYS[election]:
                return election
        return None
    kind, year = coded
    if kind == "runoff" and contribution["committee"] not in runoffs:
        return None  # designated for a runoff the candidate did not have (to be refunded or redesignated)
    return kind if year == "2026" and kind in ELECTIONS else None


def donor_key(last, first, zip5):
    """Last name, first name without middle initial or suffix, and ZIP5."""
    last_words = [w for w in re.sub(r"[^A-Z ]", " ", last.upper().replace("'", "")).split() if w not in SUFFIXES]
    first_words = [w for w in re.sub(r"[^A-Z ]", " ", first.upper().replace("'", "")).split() if w not in SUFFIXES]
    # "J ROBERT" keeps ROBERT only when the first word is a lone initial.
    if len(first_words) > 1 and len(first_words[0]) == 1:
        first_words = first_words[1:]
    return " ".join(last_words), first_words[0] if first_words else "", zip5


def donor_groups(contributions, runoffs):
    """{(committee, election, key): [contributions sorted by date, transaction id]}."""
    groups = defaultdict(list)
    for c in contributions:
        election = resolve(c, runoffs)
        if election is None:
            continue
        c["election"] = election
        groups[c["committee"], election, c["key"]].append(c)
    for rows in groups.values():
        rows.sort(key=lambda c: (c["day"], c["tid"]))
    return groups


def maxout(rows):
    """("single_gift" | "accumulated" | None, over-limit contribution count) for one donor-election."""
    positive = [c["amount"] for c in rows if c["amount"] > 0]
    over = sum(1 for amount in positive if amount > LIMIT_CENTS)
    if sum(positive) < LIMIT_CENTS:
        return None, over
    return ("single_gift" if max(positive) >= LIMIT_CENTS else "accumulated"), over


def aggregate_check(groups):
    """Compare our donor grouping with the committee-reported aggregate (column 21).

    For each donor-election, the reported aggregate on its last row is compared with
    our sums, in order: the running sum for that election; the total through the end of
    that row's report period (some filers repeat one period-end aggregate on every row);
    the same across all elections (cycle-to-date aggregates). Anything else is a
    disagreement, classified by its likely cause. Returns counts and a few anonymous
    examples (amounts and dates only).
    """
    cycle = defaultdict(list)
    for (committee, _, key), rows in groups.items():
        cycle[committee, key] += rows
    counts = defaultdict(int)
    examples = defaultdict(list)
    for (committee, election, key), rows in groups.items():
        last = rows[-1]
        reported = last["aggregate"]
        running = sum(c["amount"] for c in rows)
        period = sum(c["amount"] for c in rows if c["period_end"] <= last["period_end"])
        across = sum(c["amount"] for c in cycle[committee, key] if c["period_end"] <= last["period_end"])
        if reported is None:
            cause = "no aggregate reported"
        elif reported == running:
            cause = "agrees: running sum for the election"
        elif reported == period:
            cause = "agrees: total through the end of the report period"
        elif reported == across:
            cause = "agrees: cycle-to-date across elections"
        elif 0 < reported - max(period, across) <= 20_000 or 0 < reported - running <= 20_000:
            cause = "reported higher by up to $200: earlier unitemized receipts (FEC itemizes a donor only past $200)"
        elif reported > max(running, period, across):
            cause = ("reported higher by more than $200: receipts under another name spelling or ZIP, "
                     "or aggregates carried across elections plus unitemized receipts")
        else:
            cause = ("reported lower: our key merges receipts the committee aggregates separately "
                     "(different people or records with the same name and ZIP, or a restarted aggregate)")
        counts[cause] += 1
        if not cause.startswith("agrees") and len(examples[cause]) < 3:
            examples[cause].append({"committee": committee, "election": election,
                                    "rows": [(c["day"].isoformat(), c["amount"], c["aggregate"]) for c in rows[:6]]})
    agree = sum(v for k, v in counts.items() if k.startswith("agrees"))
    return {"groups": len(groups), "agree": agree, "disagree": len(groups) - agree,
            "causes": dict(sorted(counts.items(), key=lambda kv: -kv[1])), "examples": dict(examples)}
