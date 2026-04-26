# SPDX-License-Identifier: AGPL-3.0-or-later
# © 2026 Michael Maurizi Jr.

# Per-state projection lookup. Ported from
# src/manage/src/lib/state-projections.ts — kept identical so both pipelines
# pick the same CRS for a given state. Area math is done in meters; we use
# UTM zones where a state fits cleanly, and established regional Albers
# projections where it doesn't.

# prettier-ignore
UTM_ZONE_BY_STATE: dict[str, int] = {
    "AL": 16, "AR": 15, "AZ": 12, "CO": 13, "CT": 18, "DC": 18, "DE": 18,
    "GA": 17, "HI": 4,  "IA": 15, "ID": 11, "IL": 16, "IN": 16, "KS": 14,
    "KY": 16, "LA": 15, "MA": 19, "MD": 18, "ME": 19, "MI": 16, "MN": 15,
    "MO": 15, "MS": 16, "MT": 12, "NC": 17, "ND": 14, "NE": 14, "NH": 19,
    "NJ": 18, "NM": 13, "NV": 11, "NY": 18, "OH": 17, "OK": 14, "OR": 10,
    "PA": 18, "RI": 19, "SC": 17, "SD": 14, "TN": 16, "UT": 12, "VA": 17,
    "VT": 18, "WA": 10, "WI": 16, "WV": 17, "WY": 13,
}

ALBERS_BY_STATE: dict[str, str] = {
    "AK": (
        "+proj=aea +lat_1=55 +lat_2=65 +lat_0=50 +lon_0=-154 +x_0=0 +y_0=0 "
        "+ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=m +no_defs"
    ),
    "CA": (
        "+proj=aea +lat_1=34 +lat_2=40.5 +lat_0=0 +lon_0=-120 +x_0=0 +y_0=-4000000 "
        "+datum=NAD83 +units=m +no_defs"
    ),
    "FL": (
        "+proj=aea +lat_1=24 +lat_2=31.5 +lat_0=24 +lon_0=-84 +x_0=400000 +y_0=0 "
        "+ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=m +no_defs"
    ),
    "TX": (
        "+proj=aea +lat_1=27.5 +lat_2=35 +lat_0=18 +lon_0=-100 +x_0=1500000 +y_0=6000000 "
        "+ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=m +no_defs"
    ),
}


def get_state_projection(state_abbr: str) -> str:
    key = state_abbr.upper()
    albers = ALBERS_BY_STATE.get(key)
    if albers is not None:
        return albers
    zone = UTM_ZONE_BY_STATE.get(key)
    if zone is None:
        raise ValueError(f"No projection defined for state {state_abbr}")
    return f"+proj=utm +zone={zone} +datum=WGS84 +units=m +no_defs"
