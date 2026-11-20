### Local GeoTIFFs

`generate` accepts local 8-bit RGB or grayscale GeoTIFFs with a defined CRS. Pass
an area of interest with `--location` and repeat `--geotiff` for each source file.
The first valid pixel wins where sources overlap. Tile2Net reprojects imagery to
Web Mercator, writes RGB XYZ tiles, and stitches them for inference. Areas without
imagery within the tile grid are filled with black. Inference skips stitched tiles
with no imagery at all. A grid with no valid imagery raises an error.

```bash
python -m tile2net generate --name local-ortho --output ./output --zoom 20 \
  --location '33.7533178727,-84.3871879578,33.7513196897,-84.3847846985' \
  --geotiff /path/to/west.tif --geotiff /path/to/east.tif
```

Use `--stitch_step` to control the size of the inputs sent to the model.

### Tile Images

Tile images are raster tiles delivered as image files, typically in PNG format, and they serve as the primary input for
Tile2Net.
All subsequent processes rely on these files.

#### Tile Image Zoom

The zoom level of the tiles determines the level of visible details. 
Zoom levels below 18 generally lack the detail needed to accurately detect sidewalks, crossings, and footpaths. 
Zoom levels higher than 20 (in 256 pixels base tiles) are also too zoomed in that will need larger stitched tiles
to provide the required context for the model to understand what each feature is, hence, demand more GPU memory. 
Selecting an appropriate zoom level is crucial for getting accurate result. We recommend zoom level 19 or 20.

#### Tile Image Size

Tile images are typically square-shaped, with the width and height of each tile being identical.
The size of the tile is represented by the number of pixels in the width and height, displayed as "{number of pixels in
width} x {number of pixels in height}". In the Slippy Tile Map system, the base size is 256 x 256 pixels, and Tile2Net
follows this standard.

When geolocating tiles and corresponding polygons and networks, all input tiles must have the same size and cannot be
mixed and matched.
For example, 256x256 tiles cannot be mixed with 512x512 tiles.
However, users have the option to stitch tiles of the same size into larger tiles and save them in a new folder using
the `Raster.stitch` method.

#### Tile Image Format

Tile2Net accepts XYZ tiles in PNG and JPEG format. Use `--input` with a path
template such as `path/to/tiles/z/x/y.png`.
The implicit path can contain the zoom level, e.g. path/to/tiles/z/x/y.ext, or it can be like path/to/tiles/x_y.ext. 

To see an example, check out our [jupyter notebook](examples/inference.ipynb). 

#### Tile Transparency

PNG has different types that some might have Alpha channel (usually PNG 32-bit).
That should be avoided and tiles images should have no transparency when used in the project.
Only the first three channels are loaded from a PNG.

#### Tile Image Position

The position of each tile in slippy tile system is represented by the X and Y coordinates of its top left corner in
slippy grid.
X represents the horizontal position, and Y represents the vertical position in that grid. Note: This is **not** the
same grid as used in Tile2Net project. Though, Tile2Net grid is a subset of the slippy grid that matched the area of
interest. (Slippy grid represents all the tiles in the world in that specific zoom level)

#### Tile Image Names

Tile names are defined as `{X_tile}_{Y_tile}.{file_format}`.
The X and Y coordinates are the position of the top left corner of the image (tile image position).
A tile image file name could look like this: “154374_197085PNG”. (see tile position for more info).
Although these numbers are based on the zoom level and number of tiles there is a mathematical way to convert them into
geographic coordinates. 
