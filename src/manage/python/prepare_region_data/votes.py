# SPDX-License-Identifier: AGPL-3.0-or-later
# © 2026 Michael Maurizi Jr.

# Port of src/manage/src/lib/voting-data.ts — the vote-disaggregation
# algorithms. Kept algorithmically identical so the Python pipeline produces
# the same per-block vote counts as the TS pipeline (modulo block→precinct
# assignment differences, which is the whole point of the rewrite).

from __future__ import annotations

import math
import re
from collections.abc import Iterable, Mapping
from dataclasses import dataclass
from typing import Callable, TypeVar


def _js_round(x: float) -> int:
    """Match JavaScript Math.round: round half toward +infinity.
    Python's built-in round() uses banker's rounding, which would drift
    totals by 1 relative to the TS pipeline on half-values."""
    return math.floor(x + 0.5)


# RDH shapefile zips often bundle multiple variants of the same state's data,
# one per office (e.g. `_cong_prec`, `_sldl_prec`, `_sldu_prec`, `_all_prec`).
# We want the "all offices" superset. These are tried in order; the first
# substring that matches a candidate path wins.
SHAPEFILE_PREFERENCES: tuple[str, ...] = (
    "_all_prec",
    "_no_splits_prec",
    "_all_pber",
    "_all_tx_vtd",
    "_st_prec",
    "_st_",
)


@dataclass
class PartyVotes:
    democrat: int = 0
    republican: int = 0
    other: int = 0

    def get(self, party: str) -> int:
        return getattr(self, party)

    def set(self, party: str, value: int) -> None:
        setattr(self, party, value)


# Standard RDH format: G20PRERTRU — {electionType}{YY}{office3}{party1}{name3}.
_VOTE_COL_RE = re.compile(r"^[GPCRS](\d{2})([A-Z]{3})([DRLGIOCNSMPUAWBETH])")
# Alt format used by some RDH files (e.g. wi_2024_gen_prec): {OFFICE3}{PARTY}{YY}.
# Party token is whitelisted to avoid false-matching demographic columns
# like PERSONS18 that share the {LLL}{...}{NN} shape. TOT (precomputed
# total) is intentionally omitted — it would double-count.
_VOTE_COL_RE_ALT = re.compile(
    r"^([A-Z]{3})(DEM|REP|LIB|CON|GRN|IND\d?|NP\d?|SCT|WGR)(\d{2})$"
)


def is_vote_column(name: str) -> bool:
    """True if `name` looks like a VEST vote column in either supported format."""
    return bool(_VOTE_COL_RE.match(name) or _VOTE_COL_RE_ALT.match(name))


def extract_voting_data(
    props: Mapping[str, object],
) -> tuple[dict[str, PartyVotes], str]:
    """Extract vote columns grouped by office code; also detect election year.

    Recognizes two RDH naming conventions:
      • Standard: G20PRERTRU — {electionType}{YY}{office3}{party1}{name3}
      • Alt:     PREDEM24    — {office3}{party3+}{YY}     (e.g. WI 2024)
    Mirrors extractVotingData in voting-data.ts.
    """
    by_office: dict[str, PartyVotes] = {}
    election_year = ""

    for key, value in props.items():
        match = _VOTE_COL_RE.match(key)
        if match:
            year = match.group(1)
            office = match.group(2)
            party_code = match.group(3)
        else:
            alt = _VOTE_COL_RE_ALT.match(key)
            if not alt:
                continue
            office = alt.group(1)
            token = alt.group(2)
            year = alt.group(3)
            # Map alt-format party tokens to the single-char codes the rest
            # of this function dispatches on. Anything that isn't DEM/REP
            # falls through to the "other" bucket below.
            if token == "DEM":
                party_code = "D"
            elif token == "REP":
                party_code = "R"
            else:
                party_code = "O"

        # Treat None / NaN / non-numeric strings as 0 votes — VEST DBFs
        # commonly leave precinct rows with null vote cells (fiona returns
        # them as float NaN), which the TS pipeline absorbed via parseInt's
        # NaN-to-0 coercion via `|| 0`.
        if value is None:
            votes = 0
        elif isinstance(value, float) and math.isnan(value):
            votes = 0
        elif isinstance(value, (int, float)):
            votes = int(value)
        else:
            try:
                votes = int(str(value))
            except (TypeError, ValueError):
                votes = 0

        if not election_year:
            election_year = year

        if office not in by_office:
            by_office[office] = PartyVotes()

        if party_code == "D":
            by_office[office].democrat += votes
        elif party_code == "R":
            by_office[office].republican += votes
        else:
            by_office[office].other += votes

    return by_office, election_year


def vote_field_name(office: str, party: str, election_year: str) -> str:
    """Canonical field name for (office, party, year). Matches voting-data.ts
    line 190-197: PRE is unprefixed, other offices get an OFFICE_ prefix."""
    prefix = "" if office == "PRE" else f"{office}_"
    return f"{prefix}{party}{election_year}"


def apportion(total: int, ratios: list[float]) -> list[int]:
    """Apportion an integer total into parts proportional to ratios using the
    largest-remainder method. Guarantees sum(out) == total.

    Port of voting-data.ts::apportion. Used both to disaggregate votes and to
    absorb rounding residuals in reconciliation.
    """
    s = sum(ratios)
    if s == 0:
        return [0] * len(ratios)

    exact = [(total * r) / s for r in ratios]
    floored = [int(e) for e in exact]  # floor for non-negative; same as Math.floor
    remainder = total - sum(floored)

    # Distribute remainder to entries with largest fractional parts.
    fractionals = sorted(
        (((e - floored[i]), i) for i, e in enumerate(exact)),
        key=lambda t: t[0],
        reverse=True,
    )
    for j in range(remainder):
        floored[fractionals[j][1]] += 1
    return floored


def disaggregate_block_votes(
    votes: Mapping[str, PartyVotes],
    total_votes: Mapping[str, int],
    weight: float,
    offices_found: Iterable[str],
    election_year: str,
) -> dict[str, int]:
    """Disaggregate one precinct's votes onto one block, weighted by the
    block's share of the precinct's voter-eligible population (VAP_MOD).

    The caller MUST run reconcile_precinct_votes afterward so rounding
    residuals don't drift the per-precinct totals.

    Port of voting-data.ts::disaggregateBlockVotes.
    """
    out: dict[str, int] = {}
    for office in offices_found:
        v = votes.get(office, PartyVotes())
        total = total_votes.get(office, 0)
        for party in ("democrat", "republican", "other"):
            f = vote_field_name(office, party, election_year)
            out[f] = (
                _js_round((v.get(party) / total) * weight)
                if total > 0 and weight > 0
                else 0
            )
    return out


K = TypeVar("K")


@dataclass
class Assignment:
    feature_idx: int
    weight: float


def reconcile_precinct_votes(
    precinct_assigned: dict[K, dict[str, list[Assignment]]],
    get_precinct_votes: Callable[[K], Mapping[str, PartyVotes]],
    get_vote: Callable[[int, str], int],
    set_vote: Callable[[int, str, int], None],
    election_year: str,
) -> int:
    """Reconcile per-block votes so their sum matches each precinct's exact
    totals. Port of voting-data.ts::reconcilePrecinctVotes.

    Returns the number of (precinct, office, party) triples that needed
    adjustment — useful as a sanity metric.
    """
    reconciled = 0
    for pi, office_map in precinct_assigned.items():
        votes = get_precinct_votes(pi)
        for office, assignments in office_map.items():
            v = votes.get(office, PartyVotes())
            for party in ("democrat", "republican", "other"):
                field_name = vote_field_name(office, party, election_year)
                expected = v.get(party)
                actual = sum(get_vote(a.feature_idx, field_name) for a in assignments)
                diff = expected - actual
                if diff == 0:
                    continue
                reconciled += 1
                raw_weights = [a.weight for a in assignments]
                weights = (
                    raw_weights
                    if any(w > 0 for w in raw_weights)
                    else [1.0] * len(raw_weights)
                )
                adjustments = apportion(abs(diff), weights)
                sign = 1 if diff > 0 else -1
                for i, a in enumerate(assignments):
                    set_vote(
                        a.feature_idx,
                        field_name,
                        get_vote(a.feature_idx, field_name) + sign * adjustments[i],
                    )
    return reconciled
