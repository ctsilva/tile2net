import geopandas as gpd
from shapely.geometry import LineString, Point

from tile2net.raster.tile_utils.topology import clean_deadend_dangles, remove_false_nodes


def test_pruning_keeps_connections_and_closed_loops() -> None:
    lines = gpd.GeoDataFrame(
        {'name': ['walkway', 'spur', 'fragment', 'loop', 'short_link', 'walkway_2']},
        geometry=[
            LineString([(0, 0), (30, 0)]),
            LineString([(15, 0), (15, 5)]),
            LineString([(0, 30), (2, 30)]),
            LineString([(0, 40), (3, 40), (1, 42), (0, 40)]),
            LineString([(30, 0), (32, 0)]),
            LineString([(32, 0), (60, 0)]),
        ],
        crs=3857,
        index=[10, 20, 30, 40, 50, 60],
    )

    result = clean_deadend_dangles(lines)

    assert result.name.tolist() == ['walkway', 'loop', 'short_link', 'walkway_2']
    protected = clean_deadend_dangles(lines, crosswalk_endpoints=[Point(1, 32)])
    assert protected.name.tolist() == ['walkway', 'fragment', 'loop', 'short_link', 'walkway_2']


def test_merging_respects_junctions_and_ignores_row_order() -> None:
    lines = gpd.GeoDataFrame(geometry=[
        LineString([(2, 0), (3, 0)]),
        LineString([(0, 0), (1, 0)]),
        LineString([(3, 0), (4, 0)]),
        LineString([(3, 0), (3, 1)]),
        LineString([(1, 0), (2, 0)]),
    ], crs=3857)

    result = remove_false_nodes(lines)

    assert result.crs == lines.crs
    assert len(result) == 3
    assert result.geometry.geom_equals(LineString([(0, 0), (3, 0)])).sum() == 1
