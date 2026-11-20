"""Package a Tile2Net run and optional OSM snapshot for local Autark review."""

from __future__ import annotations

import argparse
import hashlib
import json
import shutil
import tempfile
import xml.etree.ElementTree as ET
from collections import defaultdict
from pathlib import Path

import geopandas as gpd
import requests
from PIL import Image
from shapely.geometry import LineString, Point, box

from tile2net.raster.grid import Grid


HERE = Path(__file__).resolve().parent
OSM_API = 'https://api.openstreetmap.org/api/0.6/map'
MATCH_DISTANCE = 3
REVIEW_DISTANCE = 15


def project_layer(folder: Path, name: str) -> gpd.GeoDataFrame:
    for extension in ('parquet', 'shp'):
        file = folder / f'{name}.{extension}'
        if file.is_file():
            frame = gpd.read_parquet(file) if extension == 'parquet' else gpd.read_file(file)
            return frame.explode(ignore_index=True).to_crs(4326)
    return gpd.GeoDataFrame({'f_type': []}, geometry=[], crs=4326)


def export_tiles(info: dict, output: Path) -> int:
    grid = Grid(
        name=info['name'], location=info['location'], zoom=info['zoom'],
        tile_step=info['tile_step'], base_tilesize=info.get('base_tilesize', 256),
        padding=info.get('padding', True),
    )
    stitched = Path(info['project']['tiles']['stitched'])
    if not stitched.is_dir():
        return 0
    active_ids = set(info.get('active_tile_ids', ()))
    sources = {path.stem: path for path in stitched.iterdir() if path.suffix.lower() in ('.png', '.jpg', '.jpeg')}
    size, count = grid.base_tilesize, 0
    for tile in grid.tiles.flat:
        if active_ids and tile.idd not in active_ids:
            continue
        column, row = tile.position
        path = sources.get(f'{column}_{row}_{tile.idd}')
        if path is None:
            continue
        with Image.open(path) as mosaic:
            expected = grid.tile_step * size
            if mosaic.size != (expected, expected):
                raise ValueError(f'{path} has size {mosaic.size}, expected a {expected}-pixel square.')
            for x in range(grid.tile_step):
                folder = output / 'imagery' / str(grid.zoom) / str(tile.xtile + x)
                folder.mkdir(parents=True, exist_ok=True)
                for y in range(grid.tile_step):
                    mosaic.crop((x * size, y * size, (x + 1) * size, (y + 1) * size)).save(
                        folder / f'{tile.ytile + y}.png',
                    )
                    count += 1
    return count


def osm_tags(element: ET.Element) -> dict[str, str]:
    return {tag.attrib['k']: tag.attrib['v'] for tag in element.findall('tag')}


def read_osm(snapshot: bytes, extent) -> gpd.GeoDataFrame:
    records = []
    if snapshot:
        root = ET.fromstring(snapshot)
        nodes = {
            node.attrib['id']: Point(float(node.attrib['lon']), float(node.attrib['lat']))
            for node in root.findall('node')
        }
        parent_streets = defaultdict(list)
        for way in root.findall('way'):
            tags = osm_tags(way)
            refs = [node.attrib['ref'] for node in way.findall('nd')]
            if tags.get('highway') and tags.get('highway') not in ('path', 'footway', 'pedestrian', 'steps'):
                street = {key: tags[key] for key in ('name', 'highway', 'bridge', 'tunnel', 'layer') if key in tags}
                for ref in refs:
                    parent_streets[ref].append(street)
            if len(refs) < 2 or not all(ref in nodes for ref in refs):
                continue
            kind = {'sidewalk': 'sidewalk', 'crossing': 'crossing way'}.get(tags.get('footway'))
            if kind is None and any(key == 'sidewalk' or key.startswith('sidewalk:') for key in tags):
                kind = 'street tags'
            if kind and tags.get('crossing') != 'no':
                records.append(osm_record(way, kind, tags, LineString([nodes[ref] for ref in refs])))
        for node in root.findall('node'):
            tags = osm_tags(node)
            if tags.get('highway') == 'crossing' and tags.get('crossing') != 'no':
                record = osm_record(node, 'crossing node', tags, nodes[node.attrib['id']])
                record['streets'] = parent_streets[node.attrib['id']]
                records.append(record)

    records = [record for record in records if extent.intersects(record['geometry'])]
    if not records:
        return gpd.GeoDataFrame({'kind': [], 'osm_id': []}, geometry=[], crs=4326)
    return gpd.GeoDataFrame(records, geometry='geometry', crs=4326)


def osm_record(element, kind, tags, geometry) -> dict:
    return {
        'kind': kind, 'osm_id': f"{element.tag}/{element.attrib['id']}", 'tags': tags,
        'version': element.get('version'), 'timestamp': element.get('timestamp'),
        'streets': [], 'geometry': geometry,
    }


def candidates(network: gpd.GeoDataFrame, osm: gpd.GeoDataFrame, crs, has_osm: bool) -> list[dict]:
    projected = osm.to_crs(crs)
    results = []
    for index, line in network.to_crs(crs).iterrows():
        kind = line.f_type
        if kind not in ('sidewalk', 'crosswalk') or line.geometry is None or line.geometry.length == 0:
            continue
        geometry = line.geometry
        same_type = 'sidewalk' if kind == 'sidewalk' else 'crossing way'
        context = 'street tags' if kind == 'sidewalk' else 'crossing node'
        nearby = projected.sindex.query(geometry.buffer(REVIEW_DISTANCE))
        matches = []
        for feature in projected.iloc[nearby].itertuples():
            if feature.kind not in (same_type, context):
                continue
            distance = geometry.distance(feature.geometry)
            if distance > REVIEW_DISTANCE:
                continue
            overlap = None
            if feature.kind == same_type:
                overlap = geometry.intersection(feature.geometry.buffer(MATCH_DISTANCE)).length / geometry.length
            matches.append({
                'osm_id': feature.osm_id, 'kind': feature.kind,
                'distance': round(distance, 2), 'overlap': None if overlap is None else round(overlap, 3),
            })
        lines = sorted(
            (match for match in matches if match['overlap'] is not None),
            key=lambda match: (-match['overlap'], match['distance'], match['osm_id']),
        )
        other = sorted(
            (match for match in matches if match['overlap'] is None),
            key=lambda match: (match['distance'], match['osm_id']),
        )
        credible = [match for match in lines if match['overlap'] >= 0.65]
        if len(credible) > 1:
            status = 'Multiple overlaps'
        elif credible:
            status = 'Likely overlap'
        elif kind == 'crosswalk' and other and other[0]['distance'] <= MATCH_DISTANCE:
            status = 'Crossing node nearby'
        elif kind == 'sidewalk' and other and (not lines or lines[0]['overlap'] < .25):
            status = 'Street tags nearby'
        elif lines or other:
            status = 'Check alignment'
        else:
            status = 'No nearby OSM feature' if has_osm else 'OSM data unavailable'
        results.append({
            'id': f'prediction/{index}', 'feature_index': index, 'kind': kind, 'status': status,
            'length': round(geometry.length, 1), 'matches': lines[:5] + other[:3],
        })
    return results


def collection(frame: gpd.GeoDataFrame) -> dict:
    return json.loads(frame.to_json(drop_id=True))


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('city_info', type=Path)
    parser.add_argument('--output', type=Path, required=True, help='New directory for the local viewer.')
    parser.add_argument('--autark', type=Path, default=HERE.parents[2] / 'autark', help='Built Autark checkout.')
    osm_arguments = parser.add_mutually_exclusive_group()
    osm_arguments.add_argument('--osm', type=Path, help='Local OSM XML snapshot.')
    osm_arguments.add_argument('--fetch-osm', action='store_true', help='Fetch a small crop using the OSM map API.')
    parser.add_argument('--reference', type=Path, help='Optional georeferenced review geometry.')
    parser.add_argument('--title', help='Name displayed in the viewer.')
    parser.add_argument('--imagery-label', default='Tile2Net input imagery')
    args = parser.parse_args()

    dist = args.autark.expanduser().resolve() / 'autk-map' / 'dist'
    if not (dist / 'autk-map.js').is_file():
        parser.error('Build autk-map in the Autark checkout and pass that checkout to --autark.')
    if args.output.exists():
        parser.error('--output must be a new directory.')

    info = json.loads(args.city_info.read_text())
    south, north, west, east = info['bbox']
    area = gpd.GeoSeries([box(west, south, east, north)], crs=4326)
    metric = area.estimate_utm_crs()
    extent = area.to_crs(metric).buffer(REVIEW_DISTANCE + 10).to_crs(4326).iloc[0]
    snapshot = args.osm.read_bytes() if args.osm else b''
    if args.fetch_osm:
        response = requests.get(
            OSM_API, params={'bbox': ','.join(map(str, extent.bounds))},
            headers={'User-Agent': 'Tile2Net Autark local viewer'}, timeout=(10, 45),
        )
        response.raise_for_status()
        snapshot = response.content

    network = project_layer(Path(info['project']['network']), f"{info['name']}-network")
    polygons = project_layer(Path(info['project']['polygons']), f"{info['name']}-polygons")
    osm = read_osm(snapshot, extent)
    reference = (
        gpd.read_file(args.reference).to_crs(4326) if args.reference
        else gpd.GeoDataFrame(geometry=[], crs=4326)
    )
    layers = {key: collection(frame) for key, frame in (
        ('network', network), ('polygons', polygons), ('osm', osm), ('reference', reference),
    )}
    key = hashlib.sha256(json.dumps(layers, sort_keys=True).encode()).hexdigest()[:16]
    data = {
        'key': key, 'title': args.title or info['name'], 'bbox': area.total_bounds.tolist(),
        'imagery': {'label': args.imagery_label, 'zoom': info['zoom'], 'tile_size': info.get('base_tilesize', 256)},
        'osm_available': bool(snapshot), 'layers': layers,
        'candidates': candidates(network, osm, metric, bool(snapshot)),
    }

    args.output.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix='.tile2net-viewer-', dir=args.output.parent) as temp:
        package = Path(temp) / 'review'
        package.mkdir()
        for filename in ('index.html', 'viewer.mjs', 'style.css', 'icon.svg'):
            shutil.copy2(HERE / filename, package / filename)
        shutil.copytree(dist, package / 'autark')
        data['imagery']['count'] = export_tiles(info, package)
        (package / 'project.json').write_text(json.dumps(data, allow_nan=False) + '\n')
        package.rename(args.output)
    print(f"Prepared {len(data['candidates'])} review candidates in {args.output.resolve()}")


if __name__ == '__main__':
    main()
