# SPDX-License-Identifier: AGPL-3.0-or-later
# © 2026 Michael Maurizi Jr.

from prepare_region_data.votes import (
    Assignment,
    PartyVotes,
    apportion,
    disaggregate_block_votes,
    extract_voting_data,
    reconcile_precinct_votes,
    vote_field_name,
)


def test_apportion_preserves_sum():
    assert sum(apportion(100, [1, 1, 1])) == 100
    assert sum(apportion(100, [0.3, 0.3, 0.4])) == 100
    assert sum(apportion(7, [1, 2, 3, 4])) == 7


def test_apportion_zero_ratios():
    assert apportion(10, [0, 0, 0]) == [0, 0, 0]


def test_apportion_largest_remainder():
    # 10 split by [1, 1, 1] → exact [3.33, 3.33, 3.33], floored [3, 3, 3],
    # remainder 1. Any of the three positions can get it; spec says largest
    # fractional wins, which are tied, so the sort picks the first in input
    # order after stable-by-index tie-break. Any valid apportionment sums to 10.
    result = apportion(10, [1, 1, 1])
    assert sum(result) == 10
    assert all(v in (3, 4) for v in result)


def test_vote_field_name():
    assert vote_field_name("PRE", "democrat", "20") == "democrat20"
    assert vote_field_name("USS", "republican", "20") == "USS_republican20"
    assert vote_field_name("GOV", "other", "24") == "GOV_other24"


def test_extract_voting_data_basic():
    props = {
        "G20PREDBID": 100,
        "G20PRERTRU": 80,
        "G20PRELJOR": 5,
        "G20USSDROU": 90,
        "G20USSRFRE": 70,
    }
    by_office, year = extract_voting_data(props)
    assert year == "20"
    assert "PRE" in by_office and "USS" in by_office
    assert by_office["PRE"].democrat == 100
    assert by_office["PRE"].republican == 80
    assert by_office["PRE"].other == 5
    assert by_office["USS"].democrat == 90
    assert by_office["USS"].republican == 70


def test_extract_voting_data_ignores_non_matching():
    props = {"POPULATION": 1000, "NAME": "foo", "G20PREDBID": 50}
    by_office, year = extract_voting_data(props)
    assert year == "20"
    assert set(by_office.keys()) == {"PRE"}
    assert by_office["PRE"].democrat == 50


def test_extract_voting_data_nan_and_none_treated_as_zero():
    """VEST DBFs commonly have null vote cells; fiona returns float NaN.
    The TS pipeline coerced these to 0 via parseInt(...) || 0."""
    props = {
        "G20PREDBID": float("nan"),
        "G20PRERTRU": None,
        "G20PRELJOR": "",
        "G20USSDFOO": 7,
    }
    by_office, year = extract_voting_data(props)
    assert year == "20"
    assert by_office["PRE"].democrat == 0
    assert by_office["PRE"].republican == 0
    assert by_office["PRE"].other == 0
    assert by_office["USS"].democrat == 7


def test_disaggregate_and_reconcile_round_trip():
    """Two blocks in one precinct, 100 D votes, weights 60/40 VAP_MOD.
    Disaggregation: block_a = round(100 * 60/100) = 60, block_b = 40.
    Sum matches: no reconcile needed."""
    votes = {"PRE": PartyVotes(democrat=100, republican=50, other=0)}
    total = {"PRE": 100}  # total VAP_MOD in precinct
    offices = ["PRE"]
    year = "20"

    block_a = disaggregate_block_votes(votes, total, 60.0, offices, year)
    block_b = disaggregate_block_votes(votes, total, 40.0, offices, year)

    assert block_a["democrat20"] == 60
    assert block_b["democrat20"] == 40
    assert block_a["republican20"] + block_b["republican20"] == 50


def test_disaggregate_zero_weight_returns_zero():
    votes = {"PRE": PartyVotes(democrat=100, republican=0, other=0)}
    total = {"PRE": 100}
    result = disaggregate_block_votes(votes, total, 0.0, ["PRE"], "20")
    assert result["democrat20"] == 0


def test_reconcile_fixes_rounding_drift():
    """Three blocks each get round(33.333...) = 33, sum = 99, short by 1.
    Reconcile should add 1 back."""
    store: dict[tuple[int, str], int] = {
        (0, "democrat20"): 33,
        (1, "democrat20"): 33,
        (2, "democrat20"): 33,
    }
    for i in range(3):
        for field in ("republican20", "other20"):
            store[(i, field)] = 0

    precinct_assigned = {
        "P1": {
            "PRE": [
                Assignment(feature_idx=0, weight=1.0),
                Assignment(feature_idx=1, weight=1.0),
                Assignment(feature_idx=2, weight=1.0),
            ]
        }
    }

    def get_precinct_votes(_pi):
        return {"PRE": PartyVotes(democrat=100, republican=0, other=0)}

    def get_vote(idx, field):
        return store[(idx, field)]

    def set_vote(idx, field, value):
        store[(idx, field)] = value

    reconciled = reconcile_precinct_votes(
        precinct_assigned, get_precinct_votes, get_vote, set_vote, "20"
    )
    assert reconciled == 1
    assert (
        store[(0, "democrat20")]
        + store[(1, "democrat20")]
        + store[(2, "democrat20")]
        == 100
    )


def test_reconcile_fallback_uniform_when_all_zero_weights():
    """Precinct with three all-zero-weight blocks (e.g., nursing-home-only)
    should still get its 30 votes allocated uniformly, not dropped."""
    store: dict[tuple[int, str], int] = {}
    for i in range(3):
        for field in ("democrat20", "republican20", "other20"):
            store[(i, field)] = 0

    precinct_assigned = {
        "P1": {
            "PRE": [
                Assignment(feature_idx=0, weight=0.0),
                Assignment(feature_idx=1, weight=0.0),
                Assignment(feature_idx=2, weight=0.0),
            ]
        }
    }

    def get_precinct_votes(_pi):
        return {"PRE": PartyVotes(democrat=30, republican=0, other=0)}

    def get_vote(idx, field):
        return store[(idx, field)]

    def set_vote(idx, field, value):
        store[(idx, field)] = value

    reconcile_precinct_votes(
        precinct_assigned, get_precinct_votes, get_vote, set_vote, "20"
    )
    total = sum(store[(i, "democrat20")] for i in range(3))
    assert total == 30
