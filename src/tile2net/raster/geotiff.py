"""Reproject local orthophotos into the RGB XYZ tiles used by Raster."""

from __future__ import annotations

import math
from collections.abc import Iterable, Sequence
from dataclasses import dataclass
from pathlib import Path
from tempfile import NamedTemporaryFile

import numpy as np
import rasterio
import shapely
from PIL import Image
from rasterio.enums import ColorInterp, Resampling
from rasterio.transform import from_origin
from rasterio.vrt import WarpedVRT
from rasterio.warp import transform_bounds

from tile2net.logger import logger
from tile2net.raster.tile import Tile


WEB_MERCATOR = 'EPSG:3857'
WEB_MERCATOR_EDGE = math.pi * 6378137


@dataclass(frozen=True)
class Orthophoto:
    path: Path
    bounds: tuple[float, float, float, float]
    rgb_bands: tuple[int, int, int]
    has_alpha: bool

    @classmethod
    def open(cls, path: str) -> Orthophoto:
        path = Path(path).expanduser()
        with rasterio.open(path) as source:
            if source.driver != 'GTiff' or source.crs is None:
                raise ValueError(f'{path} must be a GeoTIFF with a coordinate reference system.')
            colors = source.colorinterp
            if ColorInterp.gray in colors and source.count == 1:
                bands = (1, 1, 1)
            elif all(c in colors for c in (ColorInterp.red, ColorInterp.green, ColorInterp.blue)):
                bands = (
                    colors.index(ColorInterp.red) + 1,
                    colors.index(ColorInterp.green) + 1,
                    colors.index(ColorInterp.blue) + 1,
                )
            else:
                raise ValueError(f'{path} must have RGB bands or a single grayscale band.')
            if any(source.dtypes[band - 1] != 'uint8' for band in bands):
                raise ValueError(f'{path} must have 8-bit imagery bands.')
            bounds = transform_bounds(source.crs, WEB_MERCATOR, *source.bounds)
            return cls(path, bounds, bands, ColorInterp.alpha in colors)


def write_geotiff_tiles(
    files: Sequence[str], tiles: Iterable[Tile], output: Path, size: int,
) -> np.ndarray:
    """Write an XYZ tile at a time, using the first valid source at each pixel."""
    sources = [Orthophoto.open(file) for file in files]
    footprints = shapely.STRtree([shapely.box(*source.bounds) for source in sources])
    output.mkdir(parents=True, exist_ok=True)
    covered_tiles = []
    for tile in tiles:
        span = 2 * WEB_MERCATOR_EDGE / 2**tile.zoom
        left = -WEB_MERCATOR_EDGE + tile.xtile * span
        top = WEB_MERCATOR_EDGE - tile.ytile * span
        bounds = shapely.box(left, top - span, left + span, top)
        transform = from_origin(left, top, span / size, span / size)
        rgb = np.zeros((size, size, 3), dtype=np.uint8)
        covered = np.zeros((size, size), dtype=bool)

        for index in sorted(footprints.query(bounds, predicate='intersects')):
            photo = sources[index]
            with rasterio.open(photo.path) as source, WarpedVRT(
                source, crs=WEB_MERCATOR, transform=transform, width=size, height=size,
                resampling=Resampling.bilinear, add_alpha=not photo.has_alpha,
            ) as warped:
                alpha = warped.colorinterp.index(ColorInterp.alpha) + 1
                pixels = (warped.read(alpha) > 0) & ~covered
                if pixels.any():
                    rgb[pixels] = np.moveaxis(warped.read(photo.rgb_bands), 0, -1)[pixels]
                    covered |= pixels
            if covered.all():
                break

        covered_tiles.append(covered.any())
        destination = output / f'{tile.xtile}_{tile.ytile}.png'
        with NamedTemporaryFile(dir=output, suffix='.png', delete=False) as temporary:
            staging = Path(temporary.name)
        try:
            Image.fromarray(rgb).save(staging, format='PNG')
            staging.replace(destination)
        finally:
            staging.unlink(missing_ok=True)

    if not any(covered_tiles):
        raise ValueError('The GeoTIFFs contain no valid pixels within the requested tile grid.')
    logger.info('Prepared %s XYZ tiles with GeoTIFF imagery.', sum(covered_tiles))
    return np.asarray(covered_tiles, dtype=bool)
