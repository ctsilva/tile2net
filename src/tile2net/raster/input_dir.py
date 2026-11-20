from __future__ import annotations

import copy
import dataclasses
import os
import re
from collections import deque
from os import PathLike
from pathlib import Path
from typing import Iterable, Iterator, Type

from numpy import ndarray
from toolz import curried, curry as cur, pipe

if False:
    from tile2net.raster.raster import Raster
    from tile2net.raster.tile import Tile

class InputDir:
    format: str | None = None
    root: str | None = None
    original: str | None = None
    extension: str | None = None
    raster: Raster | None = None

    def _match(self, string: str, characters: dict[str]):
        c = '|'.join(characters)
        pattern = rf"^(.*)({c})(.*)$"
        match = re.match(pattern, string)
        return match.groups()

    characters = {
        c: i
        for i, c in enumerate('xyz')
    }

    def _parse(self, value: str | PathLike[str]) -> None:
        value = os.path.normpath(os.fspath(value))
        self.original = value

        try:
            self.extension = value.rsplit('.', 1)[1]
        except IndexError:
            raise ValueError(f'No extension found in {value!r}')

        CHARACTERS: dict[str] = pipe(
            re.split(r'[/_. \-\\]', value),
            curried.filter(lambda c: len(c) == 1),
            curried.map(str.casefold),
            set,
            cur(set.__contains__),
            curried.keyfilter(d=self.characters),
        )
        if not {'x', 'y'} <= CHARACTERS.keys():
            raise ValueError(f'{self.name} failed to parse {value!r}')
        characters = CHARACTERS.copy()

        string = value
        match = self._match(string, characters)
        self.root = match[0]
        result = deque([match])

        while True:
            c = match[1]
            if not c:
                break
            del characters[match[1]]
            if not characters:
                break
            match = self._match(match[0], characters)
            result.appendleft(match)

        parts = []
        r = result[0]
        parts.append(r[0])
        parts.append(f'{{{r[1]}}}')
        parts.append(r[2])
        for r in list(result)[1:]:
            parts.append(f'{{{r[1]}}}')
            parts.append(r[2])
        format = ''.join(parts)
        self.format = format
        self.dir = parts[0].rsplit('/', 1)[0]

    def __get__(self, instance: Raster | None, owner: Type[Raster]) -> InputDir:
        if instance is None:
            return self
        bound = instance.__dict__.get(self.name, self)
        if bound.raster is not instance:
            # Raster batches are shallow copies. Bind their inherited template to the new owner.
            bound = copy.copy(bound)
            bound.raster = instance
            instance.__dict__[self.name] = bound
        return bound

    def __set__(self, instance: Raster, value: str | PathLike[str] | None) -> None:
        if value is None:
            self.__delete__(instance)
            return
        bound = copy.copy(self)
        bound.raster = instance
        bound._parse(value)
        instance.__dict__[self.name] = bound
        instance.__dict__.pop('extension', None)

    def __delete__(self, instance: Raster) -> None:
        instance.__dict__.pop(self.name, None)
        instance.__dict__.pop('extension', None)

    def __call__(self, tiles: ndarray = None) -> Iterator[Path]:
        if tiles is None:
            tiles = self.raster.tiles
        if isinstance(tiles, ndarray):
            tiles: Iterable[Tile] = tiles.flat
        format = self.format
        for tile in tiles:
            res = format.format(
                x=tile.xtile,
                y=tile.ytile,
                z=tile.zoom,
            )
            yield Path(res)

    def __bool__(self):
        return self.format is not None

    def __fspath__(self):
        return self.dir

    def __repr__(self):
        if not self.original:
            return f'{super().__repr__()} not set'
        return self.original

    def __str__(self):
        if not self.original:
            return f'{super().__repr__()} not set'
        return self.original

    def __set_name__(self, owner, name):
        self.name = name

if __name__ == '__main__':
    class Test:
        input_dir = InputDir()

        def __init__(self, input_dir: str | PathLike):
            self.zoom = 20
            self.extension = '.png'
            self.input_dir = input_dir

    @dataclasses.dataclass
    class Tile:
        xtile: int
        ytile: int
        zoom: int
    tiles = [
        Tile(1, 2, 3),
        Tile(4, 5, 6),
        Tile(7, 8, 9),
    ]

    list(test.input_dir(tiles))
    test = Test('input/dir/x/y/z.png')
    test = Test('input/dir/x_y_z.png')
    test = Test('input/dir/y/x/z.png')
    test = Test('input/dir/x/y.png')

    try:
        test = Test('input/dir/x.png')
    except ValueError:
        pass
    else:
        raise AssertionError
    try:
        test = Test('input/dir/x.png')
    except ValueError as e:
        print(e)
    else:
        raise AssertionError
    try:
        test = Test('input/dir/xy.png')
    except ValueError as e:
        print(e)
    else:
        raise AssertionError
    try:
        test = Test('input/dir/x_y_z')
    except ValueError as e:
        print(e)
    else:
        raise AssertionError

    test = Test('input/dir/arst_x_y_z.png')
    test
