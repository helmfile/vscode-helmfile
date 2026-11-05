/**
 * The effective values of a Helm chart as helmfile would render it: the
 * chart's own values.yaml defaults, overlaid with the `values:`/`set:` of
 * every helmfile release that points at this chart, plus the chart's
 * values.schema.json for descriptions and additional keys. Also knows the
 * chart's non-template files (for .Files paths) and its subcharts.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { mappingGet, parseTree, scalarPathText, walkAll, type YMapping, type YNode, type YPair, type YSequence, type YTree } from './yamlTree';
import { readSource, resolveValueFiles, stateFor, type SourceFile } from './values';
import type { ChartTemplateContext } from './chartContext';

export interface ChartKey {
    readonly key: string;
    readonly kind: 'scalar' | 'list' | 'map';
    /** Inline preview: `nginx`, `{a, b}`, `[x, y]`; null when unknown. */
    readonly preview: string | null;
    /** Where the effective value came from, e.g. `values.yaml (mychart)`, `values-prod.yaml`, `set: image.tag`. */
    readonly source: string | null;
    /** Description from values.schema.json, when present. */
    readonly description: string | null;
}

export interface ChartValueInfo {
    readonly kind: 'scalar' | 'list' | 'map';
    readonly preview: string;
    readonly source: string;
}

/** Where an effective value was written: the file and the offset of its key. */
export interface ChartValueOrigin {
    readonly file: string;
    readonly offset: number;
}

export interface ChartModel {
    readonly chart: string;
    /** Effective child keys under a dotted path (merged values + schema-only keys). */
    keysUnder(segments: readonly string[]): readonly ChartKey[];
    /** Effective value at a dotted path, or null when absent everywhere. */
    valueAt(segments: readonly string[]): ChartValueInfo | null;
    /** Keys of the elements `range` iterates over: union of list-item keys, or the map's own keys. */
    elementKeys(segments: readonly string[]): readonly ChartKey[];
    /** Description of a path from values.schema.json, or null. */
    schemaDescriptionAt(segments: readonly string[]): string | null;
    /** Why values.schema.json rejects a dotted path (`additionalProperties:
     * false` at a strict parent that does not declare the key), or null
     * when the schema allows or does not cover the path. */
    schemaRejects(segments: readonly string[]): string | null;
    /** File and key offset the effective value at a dotted path was last
     * written at (chart values.yaml or a helmfile state file), or null. */
    originAt(segments: readonly string[]): ChartValueOrigin | null;
    /** Files reachable via `.Files` (relative, `/`-separated, templates/ excluded). */
    readonly files: readonly string[];
}

const MEMO_LIMIT = 8;
const memos = new Map<string, { stamp: number; env: string; value: ChartModel }>();

/** Memoized model for the chart of a template context. */
export function chartModelFor(context: ChartTemplateContext, stamp: number, environment: string): ChartModel {
    let entry = memos.get(context.root);
    if (!entry || entry.stamp !== stamp || entry.env !== environment) {
        entry = { stamp, env: environment, value: buildModel(context, environment) };
        if (memos.size >= MEMO_LIMIT) memos.delete(memos.keys().next().value as string); // evict oldest
        memos.set(context.root, entry);
    }
    return entry.value;
}

/**
 * Resolve the collection path of a `range`/`with` block (`.Values.a.b`,
 * `$.Values.a` or `.Subcharts.<name>.Values.a`) against the (sub)chart
 * model it belongs to. Shared by completion and hover.
 */
export function iterationBaseModel(valuePath: string, context: ChartTemplateContext, stamp: number, environment: string): { model: ChartModel; segments: readonly string[] } | null {
    const withoutRoot = valuePath.startsWith('$.') ? valuePath.slice(1) : valuePath;
    if (withoutRoot.startsWith('.Subcharts.')) {
        const segments = withoutRoot.slice('.Subcharts.'.length).split('.');
        if (segments.length < 2 || segments[1] !== 'Values') return null;
        const model = subchartModel(context, segments[0], stamp, environment);
        return model ? { model, segments: segments.slice(2).filter(segment => segment.length > 0) } : null;
    }
    if (withoutRoot.startsWith('.Values.')) {
        return { model: chartModelFor(context, stamp, environment), segments: withoutRoot.slice('.Values.'.length).split('.').filter(segment => segment.length > 0) };
    }
    return null;
}

/** Values contributed by the parent chart for this dependency, as Helm
 * merges them: the parent's effective `<name>` subtree (chart defaults plus
 * its helmfile overlay) wins over the dependency's own defaults. */
interface ParentOverlay {
    /** Key of the dependency inside the parent's values (its directory name). */
    readonly key: string;
    /** The parent's effective values record and per-path sources. */
    readonly values: Record<string, unknown>;
    readonly sources: ReadonlyMap<string, string>;
    readonly locations: ReadonlyMap<string, ChartValueOrigin>;
}

/**
 * Model of a dependency chart under `<parent>/charts/<name>`: the
 * subchart's own defaults, any helmfile release pointing straight at the
 * dependency, then — as in Helm — the parent's effective `<name>` subtree
 * (parent chart defaults + the parent release's helmfile overlay).
 */
export function subchartModel(parent: ChartTemplateContext, name: string, stamp: number, environment = 'default'): ChartModel | null {
    const root = path.join(parent.root, 'charts', name);
    if (!fs.existsSync(path.join(root, 'Chart.yaml')) && !fs.existsSync(path.join(root, 'Chart.yml'))) return null;
    const memoKey = `sub:${root}`;
    let entry = memos.get(memoKey);
    if (!entry || entry.stamp !== stamp || entry.env !== environment) {
        const context: ChartTemplateContext = { root, name, valuesTree: readYamlTree(path.join(root, 'values.yaml')), subcharts: [] };
        const from = mergedValues(parent, environment);
        entry = { stamp, env: environment, value: buildModel(context, environment, { key: name, values: from.values, sources: from.sources, locations: from.locations }) };
        if (memos.size >= MEMO_LIMIT) memos.delete(memos.keys().next().value as string); // evict oldest
        memos.set(memoKey, entry);
    }
    return entry.value;
}

/* -------------------- building -------------------- */

function buildModel(context: ChartTemplateContext, environment: string, parent?: ParentOverlay): ChartModel {
    const values: Record<string, unknown> = {};
    const sources = new Map<string, string>();
    const locations = new Map<string, ChartValueOrigin>();
    const schema = readSchema(context.root);

    applyTree(values, sources, locations, context.valuesTree, `${context.name} values.yaml`, path.join(context.root, 'values.yaml'));
    applyStateOverlay(context.root, values, sources, locations, environment);
    if (parent) {
        const overlay = parent.values[parent.key];
        // A scalar/array under the dependency key cannot merge into the
        // subchart's map-shaped values; skip that pathological case.
        if (typeof overlay === 'object' && overlay !== null && !Array.isArray(overlay)) {
            applyParentOverlay(values, sources, locations, overlay as Record<string, unknown>, [parent.key], parent.sources, parent.locations);
        }
    }

    return {
        chart: context.name,
        keysUnder: segments => keysUnder(values, sources, schema, segments),
        valueAt: segments => valueAt(values, sources, segments),
        elementKeys: segments => elementKeys(values, sources, schema, segments),
        schemaDescriptionAt: segments => schemaAt(schema, segments)?.description ?? null,
        schemaRejects: segments => schemaRejects(schema, segments),
        originAt: segments => originAt(locations, segments),
        files: listFiles(context.root),
    };
}

/** Chart defaults + helmfile overlay of a context, without building the full model. */
function mergedValues(context: ChartTemplateContext, environment: string): { values: Record<string, unknown>; sources: Map<string, string>; locations: Map<string, ChartValueOrigin> } {
    const values: Record<string, unknown> = {};
    const sources = new Map<string, string>();
    const locations = new Map<string, ChartValueOrigin>();
    applyTree(values, sources, locations, context.valuesTree, `${context.name} values.yaml`, path.join(context.root, 'values.yaml'));
    applyStateOverlay(context.root, values, sources, locations, environment);
    return { values, sources, locations };
}

/** Chart defaults from the parsed values.yaml. */
function applyTree(values: Record<string, unknown>, sources: Map<string, string>, locations: Map<string, ChartValueOrigin>, tree: YTree | null, label: string, file: string): void {
    const root = rootMapping(tree);
    if (root) overlayMapping(values, sources, locations, root, [], label, file);
}

/**
 * Values contributed by helmfile: every release of the state file above the
 * chart whose `chart:` path resolves to this chart root contributes its
 * `values:` files and inline maps, then its `set:`/`setString:` entries —
 * matching helmfile's precedence (later wins).
 */
function applyStateOverlay(chartRoot: string, values: Record<string, unknown>, sources: Map<string, string>, locations: Map<string, ChartValueOrigin>, environment: string): void {
    const state = stateFor(vscode.Uri.file(path.join(chartRoot, 'Chart.yaml')));
    if (!state) return;
    const stateDir = path.dirname(state.uri.fsPath);
    for (const doc of state.tree.docs) {
        if (!doc.root) continue;
        walkAll(doc.root, node => {
            if (node.kind !== 'pair') return;
            const pair = node as YPair;
            if (pair.key !== 'chart' || !pair.value || pair.value.kind !== 'scalar') return;
            const chartText = scalarPathText(pair.value);
            if (!chartText || !chartText.startsWith('.') && !chartText.startsWith('/')) return;
            if (path.resolve(stateDir, chartText) !== chartRoot) return;
            const mapping = pair.parent;
            if (mapping && mapping.kind === 'mapping') applyRelease(state, mapping, stateDir, values, sources, locations, environment);
        });
    }
}

function applyRelease(state: SourceFile, mapping: YMapping, stateDir: string, values: Record<string, unknown>, sources: Map<string, string>, locations: Map<string, ChartValueOrigin>, environment: string): void {
    const stateFile = state.uri.fsPath;
    const valuesPair = mappingGet(mapping, 'values');
    if (valuesPair?.value && valuesPair.value.kind === 'sequence') {
        for (const item of (valuesPair.value as YSequence).items) {
            if (item.kind === 'scalar') {
                const raw = scalarPathText(item);
                for (const uri of resolveValueFiles(state, raw, environment)) {
                    const target = readSource(uri);
                    const root = target ? rootMapping(target.tree) : null;
                    if (root) overlayMapping(values, sources, locations, root, [], labelFor(raw, stateDir), uri.fsPath);
                }
            } else if (item.kind === 'mapping') {
                overlayMapping(values, sources, locations, item, [], 'values (inline)', stateFile);
            }
        }
    }
    for (const field of ['set', 'setString']) {
        const entries = mappingGet(mapping, field);
        if (!entries?.value || entries.value.kind !== 'sequence') continue;
        for (const entry of (entries.value as YSequence).items) {
            if (entry.kind !== 'mapping') continue;
            const namePair = mappingGet(entry, 'name');
            const name = namePair?.value && namePair.value.kind === 'scalar' ? scalarPathText(namePair.value) : null;
            if (!name) continue;
            const segments = name.split('.').filter(segment => segment.length > 0);
            const label = `${field}: ${name}`;
            const origin: ChartValueOrigin = { file: stateFile, offset: namePair ? namePair.keyStart : entry.start };
            const valuePair = mappingGet(entry, 'value');
            const value = valuePair?.value ? toPlain(valuePair.value) : undefined;
            const nested = mappingGet(entry, 'values');
            if (nested?.value && nested.value.kind === 'mapping') {
                overlayMapping(values, sources, locations, nested.value, segments, label, stateFile);
            } else {
                overlayValue(values, sources, locations, segments, value, label, origin);
            }
        }
    }
}

function labelFor(raw: string, stateDir: string): string {
    return raw.startsWith('/') ? path.basename(raw) : path.relative(stateDir, path.resolve(stateDir, raw)).split(path.sep).join('/');
}

/** Deep-merge a YAML mapping into `values`, recording provenance per path. */
function overlayMapping(values: Record<string, unknown>, sources: Map<string, string>, locations: Map<string, ChartValueOrigin>, mapping: YMapping, prefix: readonly string[], label: string, file: string): void {
    for (const pair of mapping.pairs) {
        if (!pair.key) continue;
        const segments = [...prefix, pair.key];
        if (pair.value && pair.value.kind === 'mapping') {
            // Record the mapping path itself, so intermediate keys carry
            // the source of the file that defined them.
            sources.set(segments.join('\u001f'), label);
            locations.set(segments.join('\u001f'), { file, offset: pair.keyStart });
            overlayMapping(values, sources, locations, pair.value, segments, label, file);
        } else {
            overlayValue(values, sources, locations, segments, pair.value ? toPlain(pair.value) : undefined, label, { file, offset: pair.keyStart });
        }
    }
}

/** One leaf write: replaces whatever was there, including whole subtrees. */
function overlayValue(values: Record<string, unknown>, sources: Map<string, string>, locations: Map<string, ChartValueOrigin>, segments: readonly string[], value: unknown, label: string, origin: ChartValueOrigin | null): void {
    let current: Record<string, unknown> = values;
    for (let i = 0; i < segments.length - 1; i++) {
        const next = current[segments[i]];
        if (typeof next !== 'object' || next === null || Array.isArray(next)) current[segments[i]] = {};
        current = current[segments[i]] as Record<string, unknown>;
    }
    const last = segments[segments.length - 1];
    current[last] = value;
    const key = segments.join('\u001f');
    sources.set(key, label);
    if (origin) locations.set(key, origin);
    for (const existing of sources.keys()) {
        if (existing !== key && existing.startsWith(key + '\u001f')) {
            sources.delete(existing);
            locations.delete(existing);
        }
    }
}

/**
 * Deep-merge the parent's effective `<name>` subtree into the subchart's
 * values, re-labelling provenance from the parent's source map: a path
 * `[name, a, b]` in parent space lands at `[a, b]` in subchart space.
 */
function applyParentOverlay(values: Record<string, unknown>, sources: Map<string, string>, locations: Map<string, ChartValueOrigin>, overlay: Record<string, unknown>, parentSegments: readonly string[], parentSources: ReadonlyMap<string, string>, parentLocations: ReadonlyMap<string, ChartValueOrigin>): void {
    const subSegments = parentSegments.slice(1); // drop the dependency key itself
    for (const [key, value] of Object.entries(overlay)) {
        if (value === undefined) continue;
        const nextParent = [...parentSegments, key];
        const parentKey = nextParent.join('\u001f');
        const label = parentSources.get(parentKey) ?? 'parent chart values';
        const origin = parentLocations.get(parentKey) ?? null;
        if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
            sources.set([...subSegments, key].join('\u001f'), label);
            if (origin) locations.set([...subSegments, key].join('\u001f'), origin);
            applyParentOverlay(values, sources, locations, value as Record<string, unknown>, nextParent, parentSources, parentLocations);
        } else {
            overlayValue(values, sources, locations, [...subSegments, key], value, label, origin);
        }
    }
}

/* -------------------- lookup -------------------- */

function valueAt(values: Record<string, unknown>, sources: Map<string, string>, segments: readonly string[]): ChartValueInfo | null {
    let current: unknown = values;
    let source = 'chart values.yaml';
    for (let i = 0; i < segments.length; i++) {
        if (typeof current !== 'object' || current === null) return null;
        current = (current as Record<string, unknown>)[segments[i]];
        if (current === undefined) return null;
        const label = sources.get(segments.slice(0, i + 1).join('\u001f'));
        if (label) source = label;
    }
    if (current === undefined) return null;
    return { ...kindOf(current), source };
}

/** File and offset the effective value at a dotted path was last written at. */
function originAt(locations: Map<string, ChartValueOrigin>, segments: readonly string[]): ChartValueOrigin | null {
    let origin: ChartValueOrigin | null = null;
    for (let i = 1; i <= segments.length; i++) {
        const hit = locations.get(segments.slice(0, i).join('\u001f'));
        if (hit) origin = hit;
    }
    return origin;
}

function keysUnder(values: Record<string, unknown>, sources: Map<string, string>, schema: unknown, segments: readonly string[]): ChartKey[] {
    const keys: ChartKey[] = [];
    let current: unknown = values;
    let source = 'chart values.yaml';
    for (let i = 0; i < segments.length; i++) {
        if (typeof current !== 'object' || current === null) return [];
        current = (current as Record<string, unknown>)[segments[i]];
        if (current === undefined) return [];
        const label = sources.get(segments.slice(0, i + 1).join('\u001f'));
        if (label) source = label;
    }
    if (typeof current !== 'object' || current === null || Array.isArray(current)) return [];
    const seen = new Set<string>();
    for (const [key, value] of Object.entries(current as Record<string, unknown>)) {
        if (value === undefined) continue;
        seen.add(key);
        keys.push({
            key,
            ...kindOf(value),
            // The key's own label when some overlay defined exactly this
            // path, else the deepest walked ancestor's label.
            source: sources.get([...segments, key].join('\u001f')) ?? source,
            description: schemaAt(schema, [...segments, key])?.description ?? null,
        });
    }
    for (const key of schemaKeys(schema, segments)) {
        if (seen.has(key)) continue;
        keys.push({ key, kind: 'map', preview: null, source: 'schema', description: schemaAt(schema, [...segments, key])?.description ?? null });
    }
    return keys;
}

function kindOf(value: unknown): { kind: ChartValueInfo['kind']; preview: string } {
    if (Array.isArray(value)) return { kind: 'list', preview: previewList(value) };
    if (typeof value === 'object' && value !== null) return { kind: 'map', preview: previewMap(value as Record<string, unknown>) };
    return { kind: 'scalar', preview: previewScalar(value) };
}

/**
 * Keys of the elements a `range` iterates over: for a list, the union of
 * the mapping items' keys (order: first appearance); for a map, its keys.
 */
function elementKeys(values: Record<string, unknown>, sources: Map<string, string>, schema: unknown, segments: readonly string[]): ChartKey[] {
    const info = valueAt(values, sources, segments);
    if (!info || info.kind === 'scalar') return [];
    if (info.kind === 'map') return keysUnder(values, sources, schema, segments);
    let current: unknown = values;
    for (const segment of segments) {
        if (typeof current !== 'object' || current === null) return [];
        current = (current as Record<string, unknown>)[segment];
        if (current === undefined) return [];
    }
    if (!Array.isArray(current)) return [];
    const keys: ChartKey[] = [];
    const seen = new Set<string>();
    for (const item of current) {
        if (typeof item !== 'object' || item === null || Array.isArray(item)) continue;
        for (const key of Object.keys(item as Record<string, unknown>)) {
            if (seen.has(key)) continue;
            seen.add(key);
            keys.push({
                key,
                ...kindOf((item as Record<string, unknown>)[key]),
                source: '(list element)',
                description: schemaAt(schema, [...segments, key])?.description ?? null,
            });
        }
    }
    return keys;
}

/** `{replicas, image, …}` — inline map preview (#16). */
function previewMap(value: Record<string, unknown>, cap = 6): string {
    const keys = Object.keys(value);
    const head = keys.slice(0, cap).join(', ');
    return `{${head}${keys.length > cap ? ', …' : ''}}`;
}

/** `[nginx, latest, …]` — inline list preview (#16). */
function previewList(value: unknown[], cap = 3): string {
    const head = value.slice(0, cap).map(item => (Array.isArray(item) ? '[…]' : typeof item === 'object' && item !== null ? '{…}' : previewScalar(item))).join(', ');
    return `[${head}${value.length > cap ? ', …' : ''}]`;
}

function previewScalar(value: unknown): string {
    const text = value === null || value === undefined ? '(empty)' : String(value);
    const firstLine = text.split('\n')[0];
    // An empty string would render as a bare `=` in inlay hints.
    if (firstLine === '') return '""';
    return firstLine.length > 60 ? firstLine.slice(0, 60) + '…' : firstLine;
}

/* -------------------- values.schema.json -------------------- */

function readSchema(root: string): unknown {
    try {
        return JSON.parse(fs.readFileSync(path.join(root, 'values.schema.json'), 'utf8'));
    } catch {
        return null;
    }
}

/** Resolve the JSON-schema node for a dotted path (properties/items/additionalProperties only). */
function schemaAt(schema: unknown, segments: readonly string[]): { description: string | null; type: string | null } | null {
    let node = schema;
    for (const segment of segments) {
        node = stepSchema(node, segment);
        if (!node) return null;
    }
    if (typeof node !== 'object' || node === null) return null;
    const record = node as Record<string, unknown>;
    return {
        description: typeof record.description === 'string' ? record.description : null,
        type: typeof record.type === 'string' ? record.type : null,
    };
}

function stepSchema(node: unknown, segment: string): unknown {
    if (typeof node !== 'object' || node === null) return null;
    const record = node as Record<string, unknown>;
    const next = record.type === 'array' ? record.items : record.properties;
    if (typeof next !== 'object' || next === null) return null;
    if (record.type === 'array') return next;
    const hit = (next as Record<string, unknown>)[segment];
    if (hit !== undefined) return hit;
    const additional = record.additionalProperties;
    return typeof additional === 'object' && additional !== null ? additional : null;
}

/** Whether a schema node would reject a key: only when the parent is an
 * object that declares `properties` with `additionalProperties: false`
 * and the key is not among them. */
function schemaRejects(schema: unknown, segments: readonly string[]): string | null {
    if (segments.length === 0) return null;
    let node = schema;
    for (const segment of segments.slice(0, -1)) {
        node = stepSchema(node, segment);
        if (!node) return null;
    }
    if (typeof node !== 'object' || node === null) return null;
    const record = node as Record<string, unknown>;
    if (record.type === 'array') return null;
    const properties = record.properties;
    const last = segments[segments.length - 1];
    if (typeof properties !== 'object' || properties === null) return null;
    if (last in (properties as Record<string, unknown>)) return null;
    if (record.additionalProperties !== false) return null;
    return `Values key "${segments.join('.')}" is not defined in values.schema.json (additionalProperties: false there)`;
}

/** Property names a schema allows under a path. */
function schemaKeys(schema: unknown, segments: readonly string[]): string[] {
    let node = schema;
    for (const segment of segments) {
        node = stepSchema(node, segment);
        if (!node) return [];
    }
    if (typeof node !== 'object' || node === null) return [];
    const properties = (node as Record<string, unknown>).properties;
    if (typeof properties !== 'object' || properties === null) return [];
    return Object.keys(properties as Record<string, unknown>);
}

/* -------------------- .Files listing -------------------- */

function listFiles(root: string): string[] {
    const result: string[] = [];
    const budget = { count: 0 };
    const visit = (dir: string, prefix: string, depth: number): void => {
        if (depth > 8 || budget.count > 500) return;
        let entries: fs.Dirent[];
        try {
            entries = fs.readdirSync(dir, { withFileTypes: true });
        } catch {
            return;
        }
        for (const entry of entries) {
            if (++budget.count > 500) return;
            // Helm's .Files excludes templates/, charts/, .helm/ and dotfiles.
            if (entry.name.startsWith('.')) continue;
            if (prefix === '' && (entry.name === 'templates' || entry.name === 'charts' || entry.name === '.helm')) continue;
            if (entry.isDirectory()) visit(path.join(dir, entry.name), prefix + entry.name + '/', depth + 1);
            else if (entry.isFile()) result.push(prefix + entry.name);
        }
    };
    visit(root, '', 0);
    return result;
}

/* -------------------- helpers -------------------- */

function rootMapping(tree: YTree | null): YMapping | null {
    for (const doc of tree?.docs ?? []) {
        if (doc.root && doc.root.kind === 'mapping') return doc.root;
    }
    return null;
}

function readYamlTree(file: string): YTree | null {
    try {
        return parseTree(fs.readFileSync(file, 'utf8'));
    } catch {
        return null;
    }
}

/** Plain-JS projection of a YAML node (previews keep scalar text). */
function toPlain(node: YNode): unknown {
    if (node.kind === 'mapping') {
        const result: Record<string, unknown> = {};
        for (const pair of node.pairs) {
            if (pair.key) result[pair.key] = pair.value ? toPlain(pair.value) : undefined;
        }
        return result;
    }
    if (node.kind === 'sequence') return node.items.map(item => (item ? toPlain(item) : null));
    return scalarPathText(node);
}
