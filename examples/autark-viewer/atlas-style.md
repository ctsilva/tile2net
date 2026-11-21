# Atlas style

Atlas borrows the restrained fills and line-weight hierarchy of `maprender`'s Citylines print studies. Its most distinctive shapes come from Tile2Net's segmentation polygons. Road widths taper and widen, edges bend, and crossings meet sidewalks at irregular angles. Atlas draws the polygon outlines already present in the run as soft, unoutlined fills. The pedestrian network sits above those fills, so you can see the path a centerline takes through an uneven footprint.

## Palette and line weights

Atlas starts with imagery off on warm paper (`#faf7ef`). Polygon opacity defaults to 35%. The table lists the fill colors before opacity is applied. Stroke widths are drawing widths in Web Mercator map units.

| Feature | Polygon fill | Line color | Line width |
| --- | --- | --- | ---: |
| Sidewalk and footpath | Sage `#a0b39f` | Dark green `#263d35` | 1.05 |
| Road | Sand `#bfae91` | Taupe `#82715c` | 0.95 |
| Crosswalk | Terracotta `#c87a67` | Brick red `#a34136` | 1.65 |
| Generated sidewalk connector | Khaki `#b6a78e` | Gray-brown `#777160` | 0.62 |
| Median link | Pale olive `#a2ad82` | Olive `#63754c` | 0.85 |

The wider brick-red crosswalk lines draw on top of paths and connectors. Thin connectors stay visible at junctions while giving crossings visual priority. Roads are typically drawn as areas in Tile2Net, so their sand fill gives the pedestrian lines context.

## Comparison layers

Separate OSM sidewalks and crossings are solid purple (`#67246c`). OSM street centerlines carrying sidewalk tags are dashed charcoal (`#4c5357`), with 7 map units of ink and a 4-unit gap. Both use a light outline (`#fff9ef`). A selected Tile2Net feature is blue (`#117198`) in Atlas.

Prepare a viewer for the [Boston Common and Public Garden example](../example.sh) using the [quick start](README.md#quick-start). Choose **Style → Atlas**, turn on **Polygons** and **Predictions**, and zoom in on the paired crossings on Charles Street to see how the road and sidewalk footprints fit around the lines. Switch **Imagery** to **Tile2Net input** to check whether an irregular edge follows the ground or comes from the prediction.

The palette and drawing order are defined in [`viewer.mjs`](viewer.mjs).
