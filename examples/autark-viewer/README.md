# Tile2Net Visualizer

Inspect a Tile2Net run against its aerial imagery and nearby OpenStreetMap (OSM) features. The viewer runs from a local directory and uses a built Autark checkout. The map requires a WebGPU-capable browser.

## Prepare and open a run

From the Tile2Net repository with its Python dependencies installed, pass the run's `tiles/*_info.json` and a new output directory. The Autark checkout must contain `autk-map/dist/autk-map.js`. The preparer reads the run's stitched tiles, network and polygons.

```sh
python examples/autark-viewer/prepare.py path/to/run/tiles/city_256_info.json \
  --autark ../autark \
  --osm path/to/snapshot.osm \
  --output ./local-review

python -m http.server 8769 --bind 127.0.0.1 --directory ./local-review
```

Open [the local viewer](http://127.0.0.1:8769). Use `--fetch-osm` in place of `--osm` to fetch the run's bounds from the OSM map API for a small area. Omit both options to inspect the run without OSM. Use `--reference` to overlay separately traced GeoJSON or another vector file supported by GeoPandas.

## Visualize a run

Use **Output by class** to see counts for the network lines and segmentation polygons. Select a class to browse its features, then select a feature to highlight and zoom to it. You can also double-click a network line on the map, or double-click a polygon when **Predictions** is turned off.

Use **Imagery** to switch between **Tile2Net input**, **Esri World Imagery**, and **Off** while keeping the same map view and overlays. The viewer starts with the run's local tiles when available. Esri tiles load over the internet when selected.

Select **Style → Atlas** for a print-inspired map with a warm background, muted areas and more emphasis on crossings. Atlas starts with imagery off. Each style remembers its imagery selection while the viewer is open.

Open **Layers** to toggle predictions, polygons, OSM, and reference traces. Adjust **Polygon opacity** to compare segmentation areas with the underlying imagery.

The OSM layer uses solid purple for separately mapped sidewalks and crossings, and dashed charcoal for street centerlines that carry sidewalk tags.

## Review a candidate

Open **OSM review** and select a sidewalk or crossing in the queue, or double-click a network line on the map. From an eligible feature in Visualize, **Review match** opens that candidate directly.

The matching preview considers comparable OSM features within 15 m. Overlap measures the share of the predicted line within 3 m of an OSM way. The viewer calls 65% or higher a likely overlap and flags multiple qualifying ways. Nearby OSM crossing nodes and roads with sidewalk tags provide context for manual review. Check the imagery and tags, especially at bridges and overlapping streets.

Choose **Retain OSM**, **Include prediction**, or **Dismiss**. Decisions persist in the browser for that project and local server address. **Export review** downloads a GeoJSON file with the selected geometries, original OSM IDs and tags where applicable, and an audit record of each reviewed candidate. The workflow keeps decisions local.
