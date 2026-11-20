import json
from importlib import import_module
from pathlib import Path

import numpy as np
import pytest
import rasterio
from PIL import Image
from rasterio.transform import from_origin

from tile2net.__main__ import main
from tile2net.raster.geotiff import WEB_MERCATOR_EDGE
from tile2net.raster.raster import Raster
from tile2net.raster.tile_utils.genutils import num2deg


def test_generate_mosaics_neighboring_geotiffs(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str],
) -> None:
    generate = import_module('tile2net.raster.generate.generate')
    monkeypatch.setattr(generate, 'ensure_weights', lambda: None)
    x, y, zoom = 154373, 197050, 19
    span = 2 * WEB_MERCATOR_EDGE / 2**zoom
    pixel = span / 256
    left, top = -WEB_MERCATOR_EDGE + x * span, WEB_MERCATOR_EDGE - y * span

    for filename, offset, width, color in (
        ('west.tif', 0, 160, (220, 20, 30)),
        ('east.tif', 128, 128, (20, 30, 220)),
    ):
        rgb = np.broadcast_to(np.array(color, dtype=np.uint8)[:, None, None], (3, 256, width)).copy()
        if offset == 0:
            rgb[:, :, 144:] = 0
        with rasterio.open(
            tmp_path / filename, 'w', driver='GTiff', width=width, height=256, count=3,
            dtype='uint8', crs='EPSG:3857', transform=from_origin(left + offset * pixel, top, pixel, pixel),
            photometric='RGB', nodata=0,
        ) as source:
            source.write(rgb)

    nw, se = num2deg(x + 0.25, y + 0.25, zoom), num2deg(x + 1.75, y + 0.75, zoom)
    main([
        'generate', '--name', 'mosaic', '--location', ','.join(map(str, (*nw, *se))),
        '--output', str(tmp_path), '--zoom', str(zoom), '--stitch_step', '1',
        '--geotiff', str(tmp_path / 'west.tif'), '--geotiff', str(tmp_path / 'east.tif'),
    ])

    project = json.loads(capsys.readouterr().out)
    raster = Raster.from_info(project['tiles']['info'])
    assert raster.active_tile_ids == [0]
    stitched, uncovered = sorted(Path(project['tiles']['stitched']).glob('*.png'))
    with Image.open(stitched) as image:
        assert image.getpixel((136, 100)) == (220, 20, 30)
        assert image.getpixel((151, 100)) == (20, 30, 220)
    with Image.open(uncovered) as image:
        assert image.getbbox() is None
