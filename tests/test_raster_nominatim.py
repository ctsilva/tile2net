import geopy.geocoders
import pytest

from tile2net.raster.nominatim import Nominatim


def test_bundled_geocoding_cache_works_offline(monkeypatch: pytest.MonkeyPatch) -> None:
    def reject_network(*args, **kwargs):
        pytest.fail("A bundled location should be resolved without a live request")

    monkeypatch.setattr(geopy.geocoders.Nominatim, "geocode", reject_network)
    monkeypatch.setattr(Nominatim.sqlite, "read", False)

    location = Nominatim(user_agent="tile2net-tests").geocode("New York")

    assert "New York" in location.address
