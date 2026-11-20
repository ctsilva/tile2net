"""Run a fixed Tile2Net crop and report stage timing and network checks."""

from __future__ import annotations

import argparse
import json
import os
import platform
import subprocess
import sys
import time
from pathlib import Path

import geopandas as gpd
import numpy as np
import shapely


def run_cli(arguments: list[str], log: Path, environment: dict[str, str], stdout) -> float:
    start = time.perf_counter()
    with log.open('w') as stderr:
        result = subprocess.run(
            [sys.executable, '-m', 'tile2net', *arguments],
            stdout=stdout, stderr=stderr, env=environment,
        )
    if result.returncode:
        raise SystemExit(f'Tile2Net {arguments[0]} failed. See {log}.')
    return round(time.perf_counter() - start, 3)


def stage_metrics(log: Path) -> dict[str, float | int]:
    for line in log.read_text().splitlines():
        _, marker, data = line.partition('STAGE_METRICS ')
        if marker:
            metrics = dict(field.split('=', 1) for field in data.split())
            return {key: int(value) if key == 'tiles' else float(value) for key, value in metrics.items()}
    raise ValueError(f'No inference stage timings found in {log}.')


def network_checks(path: Path, reference: gpd.GeoDataFrame | None, tolerance: float) -> dict:
    network = gpd.read_parquet(path) if path.is_file() else gpd.GeoDataFrame(
        {'f_type': []}, geometry=[], crs=4326,
    )
    counts = network.f_type.value_counts().to_dict()
    result = {'features': counts, 'crosswalks': 0, 'connected_at_both_ends': 0}
    if network.empty and reference is None:
        return result

    crs_source = network if reference is None else reference
    crs = crs_source.estimate_utm_crs()
    network = network.to_crs(crs)
    sidewalks = shapely.union_all(network.geometry[network.f_type == 'sidewalk'].array)
    connectors = network.geometry[network.f_type == 'sidewalk_connection'].array
    links = connectors[shapely.distance(connectors, sidewalks) <= tolerance]
    reachable = shapely.union_all([sidewalks, *links])

    crosswalks = shapely.get_parts(
        shapely.line_merge(shapely.union_all(network.geometry[network.f_type == 'crosswalk'].array))
    )
    result['crosswalks'] = len(crosswalks)
    result['connected_at_both_ends'] = int(np.count_nonzero(
        (shapely.distance(shapely.get_point(crosswalks, 0), reachable) <= tolerance)
        & (shapely.distance(shapely.get_point(crosswalks, -1), reachable) <= tolerance)
    ))
    if reference is not None:
        traced = shapely.union_all(reference.to_crs(crs).geometry.array)
        covered = traced.intersection(sidewalks.buffer(tolerance)).length
        result['reference_sidewalk_m'] = round(traced.length, 3)
        result['matched_reference_sidewalk_m'] = round(covered, 3)
        result['reference_sidewalk_coverage'] = round(covered / traced.length, 4)
    return result


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('settings', type=Path, help='JSON with location, zoom and stitch_step.')
    parser.add_argument('--output', type=Path, required=True, help='New directory for runs and report.json.')
    parser.add_argument('--geotiff', type=Path, nargs='+', help='Source GeoTIFFs in priority order.')
    parser.add_argument('--device', choices=('cpu', 'mps', 'cuda'), action='append')
    parser.add_argument('--repeats', type=int, default=1)
    parser.add_argument('--cpu-threads', type=int, default=4)
    parser.add_argument('--dump-percent', type=int, default=0)
    parser.add_argument('--reference-sidewalks', type=Path, help='Optional traced lines for the coverage check.')
    parser.add_argument('--tolerance-m', type=float, default=2.0)
    args = parser.parse_args()
    if min(args.repeats, args.cpu_threads, args.tolerance_m) <= 0 or not 0 <= args.dump_percent <= 100:
        parser.error('Repeats, CPU threads and tolerance must be positive. Dump percent must be 0–100.')
    if args.output.exists():
        parser.error('--output must be a new directory.')

    settings = json.loads(args.settings.read_text())
    if args.geotiff:
        images = [value for path in args.geotiff for value in ('--geotiff', str(path.resolve()))]
    elif 'input_pattern' in settings:
        images = ['--input', str((args.settings.parent / settings['input_pattern']).resolve())]
    else:
        parser.error('Choose --geotiff or define input_pattern in the settings file.')

    reference = gpd.read_file(args.reference_sidewalks) if args.reference_sidewalks else None
    if reference is not None and (
        reference.empty or not reference.crs or not reference.geom_type.isin(['LineString', 'MultiLineString']).all()
        or shapely.union_all(reference.geometry.array).length == 0
    ):
        parser.error('The reference file must contain georeferenced sidewalk lines.')

    environment = dict(os.environ, OMP_NUM_THREADS=str(args.cpu_threads))
    environment.pop('PYTORCH_ENABLE_MPS_FALLBACK', None)
    runs = []
    args.output.mkdir(parents=True)
    devices = args.device or ['cpu', 'mps']
    for repeat in range(1, args.repeats + 1):
        for device in dict.fromkeys(devices):
            run = args.output.resolve() / f'{device}-{repeat}'
            run.mkdir()
            output = run / 'project.json'
            with output.open('w') as stdout:
                generation_wall = run_cli([
                    'generate', '--name', 'benchmark', '--location', settings['location'],
                    '--zoom', str(settings['zoom']), '--stitch_step', str(settings['stitch_step']),
                    '--output', str(run), *images,
                ], run / 'generate.log', environment, stdout)
            project = json.loads(output.read_text())
            log = run / 'inference.log'
            inference_wall = run_cli([
                'inference', '--device', device, '--local', '--eval', 'test',
                '--city_info', project['tiles']['info'], '--interactive',
                '--dump_percent', str(args.dump_percent),
            ], log, environment, subprocess.DEVNULL)
            result = {
                'device': device, 'repeat': repeat, 'generation_wall_seconds': generation_wall,
                'inference_wall_seconds': inference_wall, **stage_metrics(log),
                'network': network_checks(
                    Path(project['network']) / 'benchmark-network.parquet', reference, args.tolerance_m,
                ),
            }
            runs.append(result)
            print(json.dumps(result), flush=True)

    report = {
        'platform': platform.platform(), 'settings': settings, 'imagery_arguments': images,
        'cpu_threads': args.cpu_threads, 'dump_percent': args.dump_percent, 'tolerance_m': args.tolerance_m,
        'reference_sidewalks': str(args.reference_sidewalks.resolve()) if args.reference_sidewalks else None,
        'runs': runs,
    }
    (args.output / 'report.json').write_text(json.dumps(report, indent=2) + '\n')


if __name__ == '__main__':
    main()
