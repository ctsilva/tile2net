__all__ = ['generate', 'Namespace']

import argh
from pathlib import Path
from tempfile import gettempdir
from typing import Any

from tile2net.raster.generate.commandline import commandline, Namespace
from tile2net.raster.weights import ensure_weights


def _raster_from_info(info: dict[str, Any]) -> Any:
    """Construct Raster lazily so importing the CLI does not load GeoPandas."""
    from tile2net.raster.raster import Raster

    return Raster.from_info(info)


@commandline
def generate(args: Namespace) -> str:
    """Generate a JSON file representing the tile2net project file structure."""
    info = vars(args).copy()
    geotiffs = info.pop('geotiff', None)
    if geotiffs:
        if info.get('input_dir') or info.get('source'):
            raise argh.CommandError('--geotiff cannot be combined with --input or --source.')
        if info['tile_step'] != 1:
            raise argh.CommandError('GeoTIFF generation requires --tile_step 1. Use --stitch_step to combine tiles.')
        if args.stitch_step < 1 or args.stitch_step & (args.stitch_step - 1):
            raise argh.CommandError('--stitch_step must be a positive power of two.')
        output = Path(info.get('output_dir') or Path(gettempdir()) / 'tile2net').expanduser().resolve()
        tile_dir_name = f"{info['base_tilesize']}_{info['zoom']}"
        input_dir = output / info['name'] / 'tiles' / 'geotiff' / tile_dir_name
        info.update(output_dir=str(output), input_dir=str(input_dir / 'x_y.png'))
    raster = _raster_from_info(info)
    ensure_weights()
    if geotiffs:
        raster.generate(args.stitch_step, geotiffs=geotiffs)
    else:
        raster.generate(args.stitch_step)
    # raster.save_info_json(new_tstep=args.stitch_step)
    # json.dump(
    #     dict(raster.project.structure),
    #     fp=sys.stdout,
    #     allow_nan=False,
    #     indent=4,
    # )

if __name__ == '__main__':
    argh.dispatch_command(generate)
