import { AutkMap, MapEvent, TILE_SOURCES } from './autark/autk-map.js';

const byId = (id) => document.getElementById(id);
const controls = new Map(
    [...document.querySelectorAll('[data-layer]')].map((input) => [input.dataset.layer, input]),
);
const workspaceModes = ['visualize', 'review', 'checks'];
const gapPreviewDistance = 15;
const reviewLabels = {
    retain_osm: 'Retain OSM',
    include_prediction: 'Include prediction',
    dismiss: 'Dismiss',
};
// Keep legend swatches in the same order as Autark's schemeSet1 palette.
const featureTypes = [
    { kind: 'crosswalk', label: 'Crosswalk', color: '#e41a1c' },
    { kind: 'sidewalk', label: 'Sidewalk', color: '#377eb8' },
    { kind: 'road', label: 'Road', color: '#4daf4a' },
    { kind: 'medians', label: 'Median link', color: '#984ea3' },
    { kind: 'sidewalk_connection', label: 'Sidewalk connector', color: '#ff7f00' },
];
const featureColorMap = {
    interpolator: 'schemeSet1',
    domainSpec: { type: 'user', params: featureTypes.map(({ kind }) => kind) },
};
const atlasPalette = {
    sidewalk: { ink: '#263d35', fill: '#a0b39f', width: 1.05 },
    road: { ink: '#82715c', fill: '#bfae91', width: 0.95 },
    medians: { ink: '#63754c', fill: '#a2ad82', width: 0.85 },
    sidewalk_connection: { ink: '#777160', fill: '#b6a78e', width: 0.62 },
    other: { ink: '#53605d', fill: '#acb7b3', width: 0.85 },
    // Draw crossings above the path and connector ink.
    crosswalk: { ink: '#a34136', fill: '#c87a67', width: 1.65 },
};
const atlasMapStyle = {
    background: '#faf7ef', surface: '#faf7ef', parks: '#d4e0d3', water: '#c0d8dc',
    roads: '#bfae91', buildings: '#c7c0b2', points: '#53605d', polylines: '#263d35', polygons: '#a0b39f',
};
const colors = {
    osm: { r: 103, g: 36, b: 108, alpha: 1 },
    osmStreet: { r: 76, g: 83, b: 87, alpha: 1 },
    osmOutline: { r: 255, g: 249, b: 239, alpha: 1 },
    reference: { r: 232, g: 168, b: 255, alpha: 1 },
    selected: { r: 102, g: 227, b: 255, alpha: 1 },
    atlasSelection: { r: 17, g: 113, b: 152, alpha: 1 },
    check: { r: 164, g: 80, b: 20, alpha: 1 },
};
const geometryLayers = {
    Point: 'points', MultiPoint: 'points', LineString: 'polylines', MultiLineString: 'polylines',
    Polygon: 'polygons', MultiPolygon: 'polygons',
};

function rgb(hex) {
    const value = Number.parseInt(hex.slice(1), 16);
    return { r: value >> 16, g: (value >> 8) & 255, b: value & 255, alpha: 1 };
}

function element(tag, text, className) {
    const node = document.createElement(tag);
    if (text) node.textContent = text;
    if (className) node.className = className;
    return node;
}

function action(label, callback, className) {
    const node = element('button', label, className);
    node.type = 'button';
    node.addEventListener('click', callback);
    return node;
}

function mercator([longitude, latitude]) {
    const radians = Math.PI / 180;
    const clampedLatitude = Math.min(85.05112878, Math.max(-85.05112878, latitude));
    return [
        6378137 * longitude * radians,
        6378137 * Math.log(Math.tan(Math.PI / 4 + clampedLatitude * radians / 2)),
    ];
}

function projectCoordinates(coordinates) {
    return typeof coordinates[0] === 'number' ? mercator(coordinates) : coordinates.map(projectCoordinates);
}

function projectFeature(feature) {
    const { type, coordinates } = feature.geometry;
    return { ...feature, geometry: { type, coordinates: projectCoordinates(coordinates) } };
}

function dashLine(coordinates, ink = 7, gap = 4) {
    const dashes = [];
    let drawing = true;
    let remaining = ink;
    let dash = [coordinates[0]];
    for (let i = 1; i < coordinates.length; i += 1) {
        const [x, y] = coordinates[i - 1];
        const endpoint = coordinates[i];
        const dx = endpoint[0] - x;
        const dy = endpoint[1] - y;
        const length = Math.hypot(dx, dy);
        let offset = 0;
        while (length - offset >= remaining) {
            offset += remaining;
            const cut = [x + dx * offset / length, y + dy * offset / length];
            if (drawing) {
                dash.push(cut);
                dashes.push(dash);
            }
            drawing = !drawing;
            dash = drawing ? [cut] : [];
            remaining = drawing ? ink : gap;
        }
        remaining -= length - offset;
        if (drawing && length > offset) dash.push(endpoint);
    }
    if (dash.length > 1) dashes.push(dash);
    return dashes;
}

function projectOsmStreet(feature) {
    const projected = projectFeature(feature);
    const { type, coordinates } = projected.geometry;
    const lines = type === 'LineString' ? [coordinates] : coordinates;
    return { ...projected, geometry: { type: 'MultiLineString', coordinates: lines.flatMap((line) => dashLine(line)) } };
}

function mapFeature(type, coordinates) {
    return { type: 'Feature', properties: {}, geometry: { type, coordinates } };
}

function gapFeature(flag) {
    if (!flag.nearest_path || (!flag.sidewalkGap && flag.gap_m > gapPreviewDistance)) return null;
    return mapFeature('LineString', [flag.point, flag.nearest_path.point]);
}

function projectGap(feature) {
    const points = projectFeature(feature).geometry.coordinates;
    const [[x1, y1], [x2, y2]] = points;
    const length = Math.hypot(x2 - x1, y2 - y1);
    return length ? mapFeature('MultiLineString', dashLine(points, length / 5, length / 10))
        : mapFeature('LineString', points);
}

function selectionBounds(feature) {
    const bounds = [Infinity, Infinity, -Infinity, -Infinity];
    function include(coordinates) {
        if (typeof coordinates[0] !== 'number') {
            coordinates.forEach(include);
            return;
        }
        const [x, y] = coordinates;
        bounds[0] = Math.min(bounds[0], x - 24);
        bounds[1] = Math.min(bounds[1], y - 24);
        bounds[2] = Math.max(bounds[2], x + 24);
        bounds[3] = Math.max(bounds[3], y + 24);
    }
    include(feature.geometry.coordinates);
    return bounds;
}

function candidateName(candidate) {
    const kind = candidate.kind === 'crosswalk' ? 'Crossing' : 'Sidewalk';
    return `${kind} ${candidate.feature_index + 1}`;
}

function preferredMatch(candidate) {
    const contextKind = { 'Crossing node nearby': 'crossing node', 'Street tags nearby': 'street tags' }[candidate.status];
    return candidate.matches.find((match) => match.kind === contextKind) ?? candidate.matches[0];
}

function downloadJson(data) {
    const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2) + '\n'], { type: 'application/geo+json' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = 'tile2net-osm-review.geojson';
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function start(project) {
    const { layers, candidates, imagery, bbox } = project;
    const checks = project.network_checks;
    const crossingFlags = checks?.flags ?? [];
    const sidewalkFlags = (checks?.sidewalk_gaps?.flags ?? []).map((flag) => ({ ...flag, sidewalkGap: true }));
    const flags = [...crossingFlags, ...sidewalkFlags];
    const checkRows = [];
    let activeCheck = 0;
    const osm = new Map(layers.osm.features.map((feature) => [feature.properties.osm_id, feature]));
    const osmStreets = layers.osm.features.filter((feature) => feature.properties.kind === 'street tags');
    const osmFootpaths = layers.osm.features.filter((feature) => feature.properties.kind !== 'street tags');
    const byFeature = new Map(candidates.map((candidate) => [candidate.feature_index, candidate]));
    const outputGroups = ['network', 'polygons'];
    const output = new Map(outputGroups.map((group) => [group, layers[group].features.map((feature, index) => ({
        group, index, feature,
        kind: featureTypes.some(({ kind }) => kind === feature.properties?.f_type) ? feature.properties.f_type : 'other',
    }))]));
    const outputFeatures = [...output.values()].flat().filter(({ feature }) => geometryLayers[feature.geometry?.type]);
    const classes = [{ kind: 'all', label: 'All classes' }, ...featureTypes, { kind: 'other', label: 'Other' }];
    const names = new Map(classes.map(({ kind, label }) => [kind, label]));
    const featureList = byId('feature-list');
    const classButtons = new Map();
    let browseClass = 'all';
    let browseLimit = 60;
    let inspected;
    let mode = 'visualize';
    let atlas = false;
    const osmVisibility = { visualize: false, review: true, checks: false };
    const storageKey = `tile2net-review:${project.key}`;
    const decisions = new Map();
    try {
        const saved = JSON.parse(localStorage.getItem(storageKey) ?? '{}');
        for (const candidate of candidates) {
            const entry = saved[candidate.id];
            if (entry && Object.hasOwn(reviewLabels, entry.action)) decisions.set(candidate.id, entry);
        }
    } catch (error) {
        console.warn('Review storage could not be read.', error);
    }

    let current = candidates.find((candidate) => candidate.status === 'Crossing node nearby') ?? candidates[0];
    let selectedMatch = current && preferredMatch(current);
    let map;
    const groups = new Map([...controls.keys()].map((name) => [name, []]));
    const atlasGroups = new Map();
    const sourceIndices = new Map();
    byId('project-name').textContent = project.title;
    byId('reference-toggle').hidden = !layers.reference.features.length;
    controls.get('network').disabled = !layers.network.features.length;
    controls.get('osm').disabled = !layers.osm.features.length;
    controls.get('polygons').disabled = !layers.polygons.features.length;

    function setMode(next) {
        if (mode === next) return;
        const osmToggle = controls.get('osm');
        osmVisibility[mode] = osmToggle.checked;
        mode = next;
        byId('workspace').classList.toggle('is-review', mode === 'review');
        for (const name of workspaceModes) {
            byId(`${name}-panel`).hidden = name !== mode;
            byId(`${name}-mode`).setAttribute('aria-pressed', String(name === mode));
        }
        osmToggle.checked = !osmToggle.disabled && osmVisibility[mode];
        osmToggle.dispatchEvent(new Event('change'));
        // Autark updates the WebGPU viewport on a window resize.
        window.dispatchEvent(new Event('resize'));
    }

    function featureName(record) {
        return `${names.get(record.kind)} ${record.index + 1}`;
    }

    function zoomToCheck(flag) {
        if (!map) return;
        const detail = gapFeature(flag) ?? mapFeature('Point', flag.point);
        map.fitBounds(selectionBounds(projectFeature(detail)));
    }

    function renderCheckDetails() {
        const container = byId('check-details');
        const flag = flags[activeCheck];
        if (!flag) return;
        const feature = output.get('network')[flag.feature_index];
        const nearest = output.get('network')[flag.nearest_path?.feature_index];
        const heading = element('h3', flag.sidewalkGap ? 'Possible sidewalk gap' : featureName(feature));
        const distance = nearest ? `${flag.gap_m.toFixed(2)} m to ${featureName(nearest)}`
            : 'No sidewalk or attached connector in this run.';
        const endpoint = flag.end === 'start' ? 'Start endpoint' : 'End endpoint';
        const actions = element('div', '', 'feature-actions');
        const zoom = action(flag.sidewalkGap ? 'Zoom to gap' : 'Zoom to endpoint', () => zoomToCheck(flag));
        zoom.disabled = !map;
        actions.append(zoom);
        const candidate = byFeature.get(flag.feature_index);
        if (candidate && project.osm_available) {
            actions.append(action('Review OSM match', () => {
                setMode('review');
                selectCandidate(candidate);
                byId('details-title').focus();
            }));
        }
        const measurement = flag.sidewalkGap ? `${flag.gap_m.toFixed(2)} m between ${featureName(feature)} and ${featureName(nearest)}.`
            : `${endpoint} · ${distance}`;
        container.replaceChildren(heading, element('p', measurement, 'muted'));
        if (flag.nearest_path?.near_opposite_end) {
            container.append(element('p', 'The other end is already within tolerance of this path.', 'muted'));
        }
        if (flag.near_crop_edge) container.append(element('p', 'This endpoint is within 15 m of the project boundary.', 'muted'));
        container.append(actions);
    }

    function selectCheck(index) {
        checkRows[activeCheck].setAttribute('aria-current', 'false');
        activeCheck = index;
        checkRows[index].setAttribute('aria-current', 'true');
        renderCheckDetails();
        zoomToCheck(flags[index]);
        highlightSelection();
    }

    function renderChecks() {
        const summary = byId('checks-summary');
        const sidewalkSummary = byId('sidewalk-check-summary');
        if (!checks) {
            summary.textContent = 'Prepare this project with the current viewer to add network checks.';
            sidewalkSummary.textContent = 'Sidewalk gap results are unavailable for this package.';
            return;
        }
        if (!checks.checked_endpoints) {
            summary.textContent = 'No crossing endpoints to check in this run.';
        } else {
            const count = crossingFlags.length === 1 ? '1 flagged endpoint' : `${crossingFlags.length.toLocaleString()} flagged endpoints`;
            summary.textContent = `${count} · ${checks.checked_endpoints.toLocaleString()} checked · ${checks.tolerance_m} m tolerance`;
            if (!crossingFlags.length) {
                summary.append(element('br'), 'All checked endpoints are within tolerance of a sidewalk or attached connector.');
            }
        }
        if (checks.sidewalk_gaps) {
            const count = sidewalkFlags.length === 1 ? '1 possible gap' : `${sidewalkFlags.length.toLocaleString()} possible gaps`;
            sidewalkSummary.textContent = `${count} · Facing sidewalk ends up to ${checks.sidewalk_gaps.max_gap_m} m apart`;
        } else {
            sidewalkSummary.textContent = 'Prepare this project again to add sidewalk gap checks.';
        }
        if (!flags.length) return;
        byId('check-results').hidden = false;
        const list = byId('check-list');
        flags.forEach((flag, index) => {
            const feature = output.get('network')[flag.feature_index];
            const endpoint = flag.end === 'start' ? 'Start' : 'End';
            const gap = flag.gap_m === null ? 'No path' : `${flag.gap_m.toFixed(2)} m gap`;
            const row = action('', () => selectCheck(index), 'feature-row');
            row.setAttribute('aria-current', String(index === activeCheck));
            const name = flag.sidewalkGap ? `Sidewalks ${flag.feature_index + 1} & ${flag.nearest_path.feature_index + 1}`
                : `${featureName(feature)} · ${endpoint}`;
            row.append(element('span', name), element('span', gap, 'feature-meta'));
            checkRows.push(row);
            list.append(row);
        });
        renderCheckDetails();
    }

    function zoomToFeature(record) {
        map?.fitBounds(selectionBounds(projectFeature(record.feature)));
    }

    function renderInspector() {
        const inspector = byId('feature-inspector');
        inspector.replaceChildren();
        inspector.hidden = !inspected;
        if (!inspected) return;
        const candidate = inspected.group === 'network' && byFeature.get(inspected.index);
        const geometry = inspected.group === 'network' ? 'Network line' : 'Segmentation area';
        const length = candidate ? ` · ${candidate.length} m` : '';
        const actions = element('div', '', 'feature-actions');
        const zoom = action('Zoom to feature', () => zoomToFeature(inspected));
        zoom.disabled = !map;
        actions.append(zoom, action('Clear', () => inspectFeature()));
        if (candidate) {
            actions.append(action('Review match', () => {
                setMode('review');
                selectCandidate(candidate);
                byId('details-title').focus();
            }));
        }
        inspector.append(element('h3', featureName(inspected)), element('p', geometry + length, 'muted'), actions);
    }

    function renderFeatureList() {
        const visible = browseClass === 'all' ? outputFeatures : outputFeatures.filter(({ kind }) => kind === browseClass);
        byId('features-title').textContent = browseClass === 'all' ? 'Features' : names.get(browseClass) + ' features';
        byId('feature-count').textContent = visible.length.toLocaleString();
        byId('more-features').hidden = visible.length <= browseLimit;
        const scrollTop = featureList.scrollTop;
        featureList.replaceChildren();
        if (!visible.length) featureList.append(element('p', 'No output features in this run.', 'muted'));
        for (const record of visible.slice(0, browseLimit)) {
            const row = action('', (event) => {
                inspectFeature(record, true);
                if (!event.detail) featureList.querySelector('[aria-current="true"]')?.focus();
            }, 'feature-row');
            row.setAttribute('aria-current', String(inspected === record));
            row.append(element('span', featureName(record)),
                element('span', record.group === 'network' ? 'Line' : 'Area', 'feature-meta'));
            featureList.append(row);
        }
        featureList.scrollTop = scrollTop;
    }

    function selectClass(kind) {
        browseClass = kind;
        browseLimit = 60;
        featureList.scrollTop = 0;
        for (const [name, button] of classButtons) button.setAttribute('aria-pressed', String(name === kind));
        renderFeatureList();
    }

    function renderClassList() {
        const counts = new Map(classes.map(({ kind }) => [kind, { network: 0, polygons: 0 }]));
        for (const { kind, group } of outputFeatures) {
            counts.get(kind)[group] += 1;
            counts.get('all')[group] += 1;
        }
        const classList = byId('class-list');
        for (const { kind, label, color } of classes) {
            const { network, polygons } = counts.get(kind);
            if (kind !== 'all' && network + polygons === 0) continue;
            const button = action('', () => selectClass(kind), 'class-grid class-row');
            if (kind === 'all') button.classList.add('class-total');
            button.setAttribute('aria-label', `${label}, ${network} lines, ${polygons} areas`);
            const name = element('span', '', 'class-name');
            if (color) {
                const swatch = element('span', '', 'class-swatch');
                swatch.style.backgroundColor = color;
                name.append(swatch);
            }
            name.append(label);
            button.append(name, element('span', network.toLocaleString()), element('span', polygons.toLocaleString()));
            classButtons.set(kind, button);
            classList.append(button);
        }
        selectClass('all');
    }

    function inspectFeature(record, zoom = false) {
        inspected = record;
        if (record) {
            const toggle = controls.get(record.group);
            if (!toggle.checked) {
                toggle.checked = true;
                toggle.dispatchEvent(new Event('change'));
            }
            if (browseClass !== 'all' && browseClass !== record.kind) selectClass(record.kind);
            if (zoom) zoomToFeature(record);
        }
        renderFeatureList();
        renderInspector();
        highlightSelection();
    }

    function renderQueue() {
        const filter = byId('filter').value;
        const visible = candidates.filter((candidate) => {
            if (filter === 'all') return true;
            if (filter === 'reviewed') return decisions.has(candidate.id);
            if (filter === 'unreviewed') return !decisions.has(candidate.id);
            return candidate.kind === filter;
        });
        byId('queue-summary').textContent = `${visible.length} of ${candidates.length} candidates`;
        byId('progress').textContent = `${decisions.size} / ${candidates.length} reviewed`;
        byId('download').disabled = !decisions.size;
        const queue = byId('queue');
        queue.replaceChildren();
        if (!visible.length) queue.append(element('p', 'No candidates in this view.', 'muted'));
        for (const candidate of visible) {
            const row = action('', (event) => {
                selectCandidate(candidate);
                if (!event.detail) queue.querySelector('[aria-current="true"]')?.focus();
            }, 'queue-item');
            row.setAttribute('aria-current', String(current === candidate));
            const heading = element('span', '', 'row-title');
            heading.append(element('span', candidateName(candidate)), element('span', `${candidate.length} m`, 'row-length'));
            const decision = decisions.get(candidate.id);
            const tone = decision ? ' decided' : candidate.status === 'Likely overlap' ? '' : ' attention';
            row.append(heading, element('span', decision ? reviewLabels[decision.action] : candidate.status, `badge${tone}`));
            queue.append(row);
        }
    }

    function renderDetails() {
        const detail = byId('details');
        detail.replaceChildren();
        if (!current) {
            detail.append(element('p', 'This run has no sidewalk or crossing candidates.', 'muted'));
            return;
        }
        const heading = element('div', '', 'candidate-heading');
        heading.append(element('h3', candidateName(current)), element('span', `${current.length} m`, 'muted'));
        detail.append(heading, element('p', current.status));
        const zoom = action('Zoom to candidate', () => {
            const prediction = layers.network.features[current.feature_index];
            map.fitBounds(selectionBounds(projectFeature(prediction)));
        });
        zoom.disabled = !map;
        detail.append(zoom);
        detail.append(element('div', 'Nearby OSM features', 'nearby'));
        if (!current.matches.length) {
            const explanation = project.osm_available ? 'No comparable OSM features within 15 m.' : 'This project has no OSM snapshot.';
            detail.append(element('p', explanation, 'muted'));
        }
        const matches = element('div', '', 'matches');
        for (const match of current.matches) {
            const button = action(`${match.kind} · ${match.osm_id}`, (event) => {
                selectedMatch = match;
                renderDetails();
                highlightSelection();
                if (!event.detail) detail.querySelector('.match[aria-pressed="true"]')?.focus();
            }, 'match');
            button.setAttribute('aria-pressed', String(match === selectedMatch));
            const overlap = match.overlap === null ? '' : ` · ${Math.round(match.overlap * 100)}% overlap`;
            button.append(element('span', `${match.distance.toFixed(2)} m away${overlap}`, 'muted'));
            matches.append(button);
        }
        detail.append(matches);

        const feature = selectedMatch && osm.get(selectedMatch.osm_id);
        if (feature) {
            const { osm_id: id, tags, streets, version } = feature.properties;
            const link = element('a', `Open ${id} on OpenStreetMap`);
            link.href = `https://www.openstreetmap.org/${id}`;
            link.target = '_blank';
            link.rel = 'noopener noreferrer';
            detail.append(link);
            const table = element('dl', '', 'osm-tags');
            const rows = Object.entries(tags).sort(([a], [b]) => a.localeCompare(b));
            if (version) rows.push(['OSM version', version]);
            for (const street of streets) {
                const { name, ...attributes } = street;
                rows.push([name ?? 'Parent street', Object.entries(attributes).map(([key, value]) => `${key}=${value}`).join(' · ')]);
            }
            for (const [key, value] of rows) table.append(element('dt', key), element('dd', value));
            detail.append(table);
        }

        const buttons = element('div', '', 'decision-actions');
        const retain = action(reviewLabels.retain_osm, () => saveDecision('retain_osm'));
        retain.disabled = !feature || selectedMatch.kind === 'street tags';
        buttons.append(retain, action(reviewLabels.include_prediction, () => saveDecision('include_prediction')),
            action(reviewLabels.dismiss, () => saveDecision('dismiss')));
        const decision = decisions.get(current.id);
        if (decision) {
            buttons.append(action('Clear decision', () => saveDecision()));
            const linked = decision.osm_id ? ` · ${decision.osm_id}` : '';
            detail.append(element('p', `Reviewed · ${reviewLabels[decision.action]}${linked}`, 'muted'));
        }
        detail.append(buttons);
    }

    function saveDecision(actionName) {
        if (actionName) {
            decisions.set(current.id, { action: actionName, osm_id: selectedMatch?.osm_id ?? null });
        } else {
            decisions.delete(current.id);
        }
        try {
            localStorage.setItem(storageKey, JSON.stringify(Object.fromEntries(decisions)));
        } catch (error) {
            console.warn('Review storage could not be written.', error);
        }
        renderQueue();
        renderDetails();
    }

    function exportReview() {
        const features = [];
        const retained = new Set();
        const review = [];
        for (const candidate of candidates) {
            const decision = decisions.get(candidate.id);
            if (!decision) continue;
            const match = candidate.matches.find((entry) => entry.osm_id === decision.osm_id);
            review.push({ prediction_id: candidate.id, ...decision, match: match ?? null });
            if (decision.action === 'include_prediction') {
                const feature = layers.network.features[candidate.feature_index];
                features.push({ ...feature, properties: { ...feature.properties, source: 'Tile2Net', prediction_id: candidate.id, nearby_osm_id: decision.osm_id } });
            }
            if (decision.action === 'retain_osm' && osm.has(decision.osm_id) && !retained.has(decision.osm_id)) {
                const feature = osm.get(decision.osm_id);
                features.push({ ...feature, properties: { ...feature.properties, source: 'OpenStreetMap' } });
                retained.add(decision.osm_id);
            }
        }
        downloadJson({ type: 'FeatureCollection', project: project.title, features, review });
    }

    function selectCandidate(candidate) {
        current = candidate;
        const saved = decisions.get(candidate.id);
        selectedMatch = candidate.matches.find((match) => match.osm_id === saved?.osm_id) ?? preferredMatch(candidate);
        renderQueue();
        renderDetails();
        highlightSelection();
    }

    function vectorLayers(id, features, style, colorMap, project = projectFeature) {
        const families = new Map();
        for (const [index, feature] of features.entries()) {
            const family = geometryLayers[feature.geometry?.type];
            if (!family) continue;
            if (!families.has(family)) families.set(family, []);
            families.get(family).push({ projected: project(feature), index });
        }
        return [...families].map(([type, items]) => {
            const layerId = `${id}-${type}`;
            const collection = { type: 'FeatureCollection', features: items.map(({ projected }) => projected) };
            map.loadCollection(layerId, { type, collection });
            if (colorMap) {
                sourceIndices.set(layerId, items.map(({ index }) => index));
                map.updateColorMap(layerId, { colorMap });
                map.updateThematic(layerId, { collection, property: 'properties.f_type' });
            }
            map.updateRenderInfo(layerId, style);
            return layerId;
        });
    }

    function osmLayers(id, features, { polylinesWidth, pointSize, street = false }) {
        const project = street ? projectOsmStreet : projectFeature;
        return [
            ...vectorLayers(`${id}-outline`, features, {
                color: colors.osmOutline, polylinesWidth: polylinesWidth + 1.2,
                pointSize: pointSize + 0.6,
            }, undefined, project),
            ...vectorLayers(id, features, { color: street ? colors.osmStreet : colors.osm, polylinesWidth, pointSize },
                undefined, project),
        ];
    }

    function atlasLayers(group) {
        const byKind = new Map();
        for (const { feature, kind } of output.get(group)) {
            if (!byKind.has(kind)) byKind.set(kind, []);
            byKind.get(kind).push(feature);
        }
        const areas = group === 'polygons';
        return Object.entries(atlasPalette).flatMap(([kind, { ink, fill, width }]) =>
            vectorLayers(`atlas-${group}-${kind}`, byKind.get(kind) ?? [], {
                color: rgb(areas ? fill : ink), polylinesWidth: width, showBorders: false, isSkip: true,
            }),
        );
    }

    function renderLegend(selected) {
        const visibleTypes = new Set();
        for (const group of outputGroups) {
            if (!controls.get(group).checked) continue;
            for (const feature of layers[group].features) visibleTypes.add(feature.properties.f_type);
        }
        const legend = byId('tile2net-legend');
        legend.replaceChildren();
        for (const { kind, label, color } of featureTypes) {
            if (!visibleTypes.has(kind)) continue;
            const item = element('span');
            const swatch = element('i');
            swatch.style.backgroundColor = atlas ? atlasPalette[kind].ink : color;
            item.append(swatch, label);
            legend.append(item);
        }
        legend.hidden = !legend.childElementCount;
        const osmVisible = controls.get('osm').checked && !controls.get('osm').disabled;
        byId('osm-legend').hidden = !osmVisible || !osmFootpaths.length;
        byId('osm-street-legend').hidden = !osmVisible || !osmStreets.length;
        byId('reference-legend').hidden = !controls.get('reference').checked || !layers.reference.features.length;
        byId('selection-legend').hidden = !selected;
        byId('check-legend').hidden = mode !== 'checks' || !flags.length;
        byId('osm-credit').hidden = !project.osm_available || !controls.get('osm').checked;
        const overlayLegend = byId('overlay-legend');
        overlayLegend.hidden = [...overlayLegend.children].every((item) => item.hidden);
        byId('map-legend').hidden = legend.hidden && overlayLegend.hidden;
    }

    let overlays = [];
    function highlightSelection() {
        if (!map) return;
        overlays.forEach((id) => map.removeLayer(id));
        overlays = [];
        const flag = mode === 'checks' ? flags[activeCheck] : null;
        const selectedIndex = mode === 'review' ? current?.feature_index : flag?.feature_index;
        const record = mode === 'visualize' ? inspected : output.get('network')[selectedIndex];
        const selected = record && controls.get(record.group).checked;
        if (selected) {
            const color = atlas ? colors.atlasSelection : colors.selected;
            const features = [record.feature];
            if (flag?.sidewalkGap) features.push(output.get('network')[flag.nearest_path.feature_index].feature);
            overlays.push(...vectorLayers('selected-prediction', features, {
                color, strokeColor: color, polylinesWidth: 1.65,
                opacity: record.group === 'polygons' ? 0.6 : 1,
            }));
        }
        const feature = mode === 'review' && selectedMatch && osm.get(selectedMatch.osm_id);
        if (feature && controls.get('osm').checked) {
            overlays.push(...osmLayers('selected-osm', [feature], {
                polylinesWidth: 2.4, pointSize: 2.1, street: feature.properties.kind === 'street tags',
            }));
        }
        if (flag) {
            const gap = gapFeature(flag);
            if (gap) {
                overlays.push(...vectorLayers('check-gap', [gap], {
                    color: colors.check, polylinesWidth: 1.3,
                }, undefined, projectGap));
                if (!flag.sidewalkGap) {
                    overlays.push(...vectorLayers('check-target', [mapFeature('Point', flag.nearest_path.point)], {
                        color: colors.check, pointSize: 0.55,
                    }));
                }
            }
        }
        renderLegend(selected);
        map.requestRender();
    }

    for (const name of workspaceModes) {
        byId(`${name}-mode`).addEventListener('click', () => setMode(name));
    }
    byId('more-features').addEventListener('click', () => {
        browseLimit += 60;
        renderFeatureList();
    });
    byId('filter').addEventListener('change', renderQueue);
    byId('download').addEventListener('click', exportReview);
    const layerMenu = document.querySelector('.layer-menu');
    document.addEventListener('click', (event) => {
        if (layerMenu.open && !layerMenu.contains(event.target)) layerMenu.open = false;
    });
    layerMenu.addEventListener('keydown', (event) => {
        if (event.key !== 'Escape' || !layerMenu.open) return;
        layerMenu.open = false;
        layerMenu.querySelector('summary').focus();
    });
    renderClassList();
    renderChecks();
    if (current) {
        selectCandidate(current);
    } else {
        renderQueue();
        renderDetails();
    }

    try {
        const instance = new AutkMap(byId('map'), false);
        await instance.init();
        map = instance;
        const [west, south, east, north] = bbox;
        const center = { longitude: (east + west) / 2, latitude: (south + north) / 2 };
        const fitProject = () => map.fitBounds([...mercator([west, south]), ...mercator([east, north])]);
        const basemap = byId('basemap');
        const mapStyle = byId('map-style');
        const initialStyle = map.style.currentStyle;
        basemap.querySelector('option[value="imagery"]').disabled = !imagery.count;
        basemap.value = imagery.count ? 'imagery' : 'off';
        let activeImagery = basemap.value;
        const imageryByStyle = { standard: activeImagery, atlas: 'off' };
        if (imagery.count) {
            map.loadTiles('imagery', {
                source: {
                    urlTemplate: new URL('imagery/', document.baseURI).href + '{z}/{x}/{y}.png',
                    attribution: imagery.label, minZoom: imagery.zoom, maxZoom: imagery.zoom, tileSize: imagery.tile_size,
                },
                crs: 'EPSG:3857', center,
                zoom: imagery.zoom, maxTiles: 256,
            });
        }
        function syncBasemap() {
            if (basemap.value === activeImagery) return;
            activeImagery = basemap.value;
            map.updateRenderInfo('imagery', { isSkip: activeImagery !== 'imagery' });
            if (activeImagery === 'esri') {
                const needsOrigin = !map.layerManager.hasOrigin;
                map.loadTiles('esri', {
                    source: TILE_SOURCES.esriWorldImagery,
                    crs: 'EPSG:3857',
                    ...(needsOrigin ? { center } : {}),
                });
                if (needsOrigin) fitProject();
            } else {
                map.removeLayer('esri');
            }
            map.requestRender();
        }
        basemap.addEventListener('change', syncBasemap);

        const opacity = byId('opacity');
        groups.set('polygons', vectorLayers('polygons', layers.polygons.features, { isColorMap: true }, featureColorMap));
        atlasGroups.set('polygons', atlasLayers('polygons'));
        opacity.addEventListener('input', () => {
            syncLayerAppearance('polygons');
            byId('opacity-value').textContent = `${opacity.value}%`;
            map.requestRender();
        });
        groups.set('reference', vectorLayers('reference', layers.reference.features, { color: colors.reference, polylinesWidth: 1.1, pointSize: 2 }));
        groups.set('osm', [
            ...osmLayers('osm-streets', osmStreets, { street: true, polylinesWidth: 1.15, pointSize: 1.2 }),
            ...osmLayers('osm', osmFootpaths, { polylinesWidth: 1.8, pointSize: 1.4 }),
        ]);
        groups.set('network', vectorLayers('network', layers.network.features, {
            isColorMap: true, polylinesWidth: 1.05,
        }, featureColorMap));
        atlasGroups.set('network', atlasLayers('network'));
        const markerFlags = flags.flatMap((flag, index) => {
            const points = flag.sidewalkGap ? [flag.point, flag.nearest_path.point] : [flag.point];
            return points.map((point) => ({ point, index }));
        });
        const markers = markerFlags.map(({ point }) => mapFeature('Point', point));
        const checkLayers = [
            ...vectorLayers('check-marker-outline', markers, { color: colors.osmOutline, pointSize: 2.7, isSkip: true }),
            ...vectorLayers('check-marker', markers, { color: colors.check, pointSize: 2, isSkip: true }),
        ];

        function syncLayerAppearance(group) {
            const visible = controls.get(group).checked;
            const styledLayers = atlasGroups.get(group);
            if (!styledLayers) {
                for (const id of groups.get(group)) map.updateRenderInfo(id, { isSkip: !visible });
                return;
            }
            const areas = group === 'polygons';
            const alpha = areas ? Number(opacity.value) / 100 : 1;
            // Keep the original layers available to GPU picking in both styles.
            for (const id of groups.get(group)) {
                map.updateRenderInfo(id, { isSkip: !visible, opacity: atlas ? 0 : alpha, showBorders: areas && !atlas });
            }
            for (const id of styledLayers) map.updateRenderInfo(id, { isSkip: !visible || !atlas, opacity: alpha });
        }

        const networkLayer = 'network-polylines';
        const polygonLayer = 'polygons-polygons';
        const checkLayer = 'check-marker-points';
        function syncPicking() {
            const checking = mode === 'checks';
            const pickLines = !checking && groups.get('network').includes(networkLayer) && controls.get('network').checked;
            const showAreas = groups.get('polygons').includes(polygonLayer) && controls.get('polygons').checked;
            const pickAreas = mode === 'visualize' && showAreas && !pickLines;
            map.updateRenderInfo(networkLayer, { isPick: pickLines });
            map.updateRenderInfo(polygonLayer, { isPick: pickAreas });
            for (const id of checkLayers) map.updateRenderInfo(id, { isSkip: !checking });
            map.updateRenderInfo(checkLayer, { isPick: checking });
            opacity.disabled = !showAreas;
            let pickHelp = '';
            if (checking && flags.length) pickHelp = ' · Double-click a flag to inspect';
            else if (pickLines) pickHelp = ' · Double-click a line to inspect';
            else if (pickAreas) pickHelp = ' · Double-click an area to inspect';
            byId('map-help').textContent = 'Drag to pan · Scroll to zoom' + pickHelp;
        }

        for (const [group, input] of controls) {
            syncLayerAppearance(group);
            input.addEventListener('change', () => {
                syncLayerAppearance(group);
                syncPicking();
                highlightSelection();
            });
        }
        mapStyle.addEventListener('change', () => {
            imageryByStyle[atlas ? 'atlas' : 'standard'] = basemap.value;
            atlas = mapStyle.value === 'atlas';
            if (atlas) map.style.setCustomStyle(atlasMapStyle);
            else map.style.setPredefinedStyle(initialStyle);
            byId('map').closest('.map-panel').dataset.mapStyle = mapStyle.value;
            basemap.value = imageryByStyle[mapStyle.value];
            syncBasemap();
            for (const group of outputGroups) syncLayerAppearance(group);
            for (const { kind, color } of featureTypes) {
                const swatch = classButtons.get(kind)?.querySelector('.class-swatch');
                if (swatch) swatch.style.backgroundColor = atlas ? atlasPalette[kind].ink : color;
            }
            highlightSelection();
        });
        map.events.on(MapEvent.PICKING, ({ layerId, selection }) => {
            const picked = selection.at(-1);
            if (mode === 'checks') {
                if (layerId === checkLayer && markerFlags[picked]) {
                    const index = markerFlags[picked].index;
                    map.setHighlightedIds(layerId, []);
                    selectCheck(index);
                    checkRows[index].scrollIntoView({ block: 'nearest' });
                }
                return;
            }
            const index = sourceIndices.get(layerId)?.[picked];
            if (index === undefined) return;
            map.setHighlightedIds(layerId, []);
            if (mode === 'visualize') {
                const group = layerId === networkLayer ? 'network' : 'polygons';
                inspectFeature(output.get(group)[index]);
                return;
            }
            const candidate = byFeature.get(index);
            if (candidate) {
                byId('filter').value = 'all';
                selectCandidate(candidate);
                byId('queue').querySelector('[aria-current="true"]')?.scrollIntoView({ block: 'nearest' });
            }
        });

        for (const [id, handler] of [
            ['zoom-in', () => map.camera.zoom(-1.2, 0.5, 0.5)],
            ['zoom-out', () => map.camera.zoom(1, 0.5, 0.5)],
            ['reset', fitProject],
        ]) {
            const button = byId(id);
            button.addEventListener('click', handler);
            button.disabled = false;
        }
        syncPicking();
        fitProject();
        highlightSelection();
        map.draw();
        renderInspector();
        renderDetails();
        renderCheckDetails();
        basemap.disabled = false;
        mapStyle.disabled = false;
        byId('map-status').hidden = true;
    } catch (error) {
        console.error(error);
        map = undefined;
        byId('map-status').textContent = 'The map could not start. Open in a browser with WebGPU enabled.';
    }
}

try {
    const response = await fetch('./project.json');
    if (!response.ok) throw new Error(`Project request failed (${response.status}).`);
    await start(await response.json());
} catch (error) {
    console.error(error);
    byId('queue-summary').textContent = 'Could not load the project.';
    byId('map-status').textContent = 'Serve a prepared project directory to open this viewer.';
}
