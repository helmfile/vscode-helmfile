/**
 * Chart context: detects that a document lives inside a Helm chart (a
 * directory whose ancestor holds Chart.yaml) and exposes the built-in
 * template variables (.Chart/.Release/…) plus the chart's own values.yaml,
 * so chart template files get completions, hovers and diagnostics that fit
 * Helm templates instead of Helmfile state files.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { isStateFileName } from './values';
import { parseTree, mappingGet, scalarPathText, type YNode, type YTree } from './yamlTree';
import { chartSupportEnabled } from './settings';

const CHART_MARKERS = ['Chart.yaml', 'Chart.yml'];
/** How many directories to walk up looking for a Chart.yaml. */
const MAX_WALK = 16;

/** Root directory of the Helm chart containing `file`, or null. */
export function chartRootOf(file: string): string | null {
    let dir = path.dirname(path.resolve(file));
    for (let depth = 0; depth < MAX_WALK; depth++) {
        if (CHART_MARKERS.some(marker => fs.existsSync(path.join(dir, marker)))) return dir;
        const parent = path.dirname(dir);
        if (parent === dir) break;
        dir = parent;
    }
    return null;
}

/** True when `file` sits directly or nested under `<root>/templates/`. */
function underTemplates(file: string, root: string): boolean {
    const rel = path.relative(root, path.dirname(path.resolve(file)));
    return rel === 'templates' || rel.startsWith('templates' + path.sep);
}

/**
 * Chart root when `file` is a Helm template file of that chart, else null.
 * Helmfile state files keep their state treatment even when they happen to
 * sit inside a chart's templates/ directory.
 */
function templateRootOf(file: string): string | null {
    if (isStateFileName(file)) return null;
    const root = chartRootOf(file);
    return root !== null && underTemplates(file, root) ? root : null;
}

/** True for files under `<chart>/templates/` — the Helm template files a chart renders. */
export function isChartTemplateFile(file: string): boolean {
    return templateRootOf(file) !== null;
}

/** fsPath of a file: URI, or null — chart features are disk-backed. */
export function chartFileOf(uri: { readonly scheme: string; readonly fsPath: string }): string | null {
    return uri.scheme === 'file' ? uri.fsPath : null;
}

export interface ChartTemplateContext {
    /** Chart root directory (the one holding Chart.yaml). */
    readonly root: string;
    /** Chart name from Chart.yaml, or the directory name. */
    readonly name: string;
    /** Parsed `values.yaml` of the chart, or null when absent/unreadable. */
    readonly valuesTree: YTree | null;
    /** Subchart directory names under `<root>/charts/`. */
    readonly subcharts: readonly string[];
}

/**
 * Memoized detection result for the most recent (file, stamp) pair, so the
 * providers asking on every keystroke walk the directory chain at most
 * once per content version. Chart files on disk that change while no
 * open document changes are picked up on the next stamp bump.
 */
const MEMO_LIMIT = 8;
const memos = new Map<string, { stamp: number; detected: boolean; value: ChartTemplateContext | null }>();

function chartMemo(file: string, stamp: number): { detected: boolean; value: ChartTemplateContext | null } {
    let entry = memos.get(file);
    if (!entry || entry.stamp !== stamp) {
        const root = templateRootOf(file);
        entry = { stamp, detected: root !== null, value: root ? computeContext(root) : null };
        if (memos.size >= MEMO_LIMIT) memos.delete(memos.keys().next().value as string); // evict oldest
        memos.set(file, entry);
    }
    return entry;
}

/**
 * True when the file is a chart template file, regardless of settings —
 * diagnostics uses this so Helmfile state checks never fire for Helm
 * template files even when chart support is switched off.
 */
export function chartTemplateDetected(file: string | null | undefined, stamp: number): boolean {
    return file !== null && file !== undefined && chartMemo(file, stamp).detected;
}

/**
 * Chart template context for a document, or null when the file is not a
 * chart template file (callers fall through to Helmfile state handling)
 * or chart support is disabled via `helmfile.chartSupport: false`.
 */
export function chartTemplateContextFor(file: string | null | undefined, stamp: number): ChartTemplateContext | null {
    if (!file) return null;
    return chartSupportEnabled() ? chartMemo(file, stamp).value : null;
}

function computeContext(root: string): ChartTemplateContext {
    return {
        root,
        name: readChartName(root),
        valuesTree: readYaml(path.join(root, 'values.yaml')),
        subcharts: readSubcharts(root),
    };
}

/** Parse a YAML file, or null when absent or unreadable. */
function readYaml(file: string): YTree | null {
    try {
        return parseTree(fs.readFileSync(file, 'utf8'));
    } catch {
        return null;
    }
}

/** Chart name from Chart.yaml, falling back to the directory name. */
function readChartName(root: string): string {
    for (const marker of CHART_MARKERS) {
        const tree = readYaml(path.join(root, marker));
        if (!tree) continue;
        for (const doc of tree.docs) {
            if (!doc.root || doc.root.kind !== 'mapping') continue;
            const namePair = doc.root.pairs.find(pair => pair.key === 'name');
            const nameValue = namePair?.value;
            if (nameValue && nameValue.kind === 'scalar') {
                const chartName = scalarPathText(nameValue).trim();
                if (chartName) return chartName;
            }
        }
    }
    return path.basename(root);
}

/** Subchart names under `<root>/charts/` (unpacked directories and packaged *.tgz). */
function readSubcharts(root: string): string[] {
    try {
        return fs
            .readdirSync(path.join(root, 'charts'), { withFileTypes: true })
            .filter(entry => entry.isDirectory() || (entry.isFile() && entry.name.endsWith('.tgz')))
            .map(entry => entry.name.replace(/\.tgz$/, ''));
    } catch {
        return []; /* no charts/ directory */
    }
}

/* -------------------- built-in template variables -------------------- */

export interface ChartBuiltin {
    /** Dotted path without the leading dot, e.g. `Chart.Name`. */
    readonly path: string;
    readonly detail: string;
    readonly documentation: string;
}

/** Root paths offered inside chart template actions. */
export const CHART_ROOT_PATHS = ['Values', 'Chart', 'Release', 'Template', 'Capabilities', 'Files', 'Subcharts'] as const;

const ROOTS = CHART_ROOT_PATHS.join('|');
/**
 * A builtin path being typed, anchored at the end of the text head:
 * captures the root and the typed sub-path of `.Chart.Nam`-like tokens.
 */
export const CHART_BUILTIN_SUFFIX = new RegExp(`(?:^|[^.A-Za-z0-9_])\\.(${ROOTS})((?:\\.[A-Za-z0-9_]*)*)$`);
/** Complete builtin paths in text, e.g. `.Chart.Name`. */
export const CHART_BUILTIN_TOKEN = new RegExp(`\\.(?:${ROOTS})(?:\\.[A-Za-z0-9_]+)+`, 'g');

/** Helm's built-in template variables, with their reference documentation. */
export const CHART_BUILTINS: readonly ChartBuiltin[] = [
    { path: 'Chart.Name', detail: 'string', documentation: 'Name of the chart (Chart.yaml `name`).' },
    { path: 'Chart.Version', detail: 'string', documentation: 'Version of the chart (Chart.yaml `version`, SemVer).' },
    { path: 'Chart.AppVersion', detail: 'string', documentation: 'Version of the application the chart deploys (Chart.yaml `appVersion`).' },
    { path: 'Chart.ApiVersion', detail: 'string', documentation: 'The chart API version — `v2` for Helm 3+ charts.' },
    { path: 'Chart.KubeVersion', detail: 'string', documentation: 'Kubernetes version constraint from Chart.yaml `kubeVersion`.' },
    { path: 'Chart.Description', detail: 'string', documentation: 'Short description of the chart.' },
    { path: 'Chart.Type', detail: 'string', documentation: 'Chart type — `application` (default) or `library`.' },
    { path: 'Chart.Home', detail: 'string', documentation: 'URL of the project home page.' },
    { path: 'Chart.Sources', detail: 'list', documentation: 'Source URLs the chart is built from.' },
    { path: 'Chart.Maintainers', detail: 'list', documentation: 'Chart maintainers (name, email, url).' },
    { path: 'Chart.Icon', detail: 'string', documentation: 'URL of the chart icon (SVG or PNG).' },
    { path: 'Chart.Keywords', detail: 'list', documentation: 'Chart keywords.' },
    { path: 'Chart.Dependencies', detail: 'list', documentation: 'Chart dependencies (alias, name, version, repository, condition, tags).' },
    { path: 'Chart.Annotations', detail: 'map', documentation: 'Chart annotations.' },
    { path: 'Chart.Condition', detail: 'string', documentation: 'Dependency condition path, set by Helm from dependencies[].condition.' },
    { path: 'Chart.Tags', detail: 'list', documentation: 'Dependency tags, set by Helm from dependencies[].tags.' },
    { path: 'Release.Name', detail: 'string', documentation: 'Name of the release (the `helm install` / helmfile release name).' },
    { path: 'Release.Namespace', detail: 'string', documentation: 'Namespace the release is installed into.' },
    { path: 'Release.Revision', detail: 'number', documentation: 'Revision number of the release; starts at 1, increments per `helm upgrade`.' },
    { path: 'Release.IsUpgrade', detail: 'bool', documentation: 'True when the current operation is an upgrade or rollback.' },
    { path: 'Release.IsInstall', detail: 'bool', documentation: 'True when the current operation is an install.' },
    { path: 'Release.Service', detail: 'string', documentation: 'The service rendering the template — always "Helm".' },
    { path: 'Template.Name', detail: 'string', documentation: 'Path of the current template file, e.g. mychart/templates/deployment.yaml.' },
    { path: 'Template.BasePath', detail: 'string', documentation: 'Template directory of the current chart, e.g. mychart/templates.' },
    { path: 'Capabilities.KubeVersion.Version', detail: 'string', documentation: 'Kubernetes cluster version, e.g. v1.31.0.' },
    { path: 'Capabilities.KubeVersion.Major', detail: 'string', documentation: 'Kubernetes major version, e.g. "1".' },
    { path: 'Capabilities.KubeVersion.Minor', detail: 'string', documentation: 'Kubernetes minor version, e.g. "31".' },
    { path: 'Capabilities.APIVersions', detail: 'object', documentation: 'API versions the cluster supports; use `.Capabilities.APIVersions.Has "batch/v1"`.' },
    { path: 'Capabilities.HelmVersion.Version', detail: 'string', documentation: 'Helm version, e.g. v3.16.0.' },
    { path: 'Capabilities.HelmVersion.Major', detail: 'string', documentation: 'Helm major version.' },
    { path: 'Capabilities.HelmVersion.Minor', detail: 'string', documentation: 'Helm minor version.' },
    { path: 'Files.Get', detail: 'func(string) string', documentation: 'File.Get name → file content as string. Paths are relative to the chart root.' },
    { path: 'Files.GetBytes', detail: 'func(string) []byte', documentation: 'File content as bytes (for binary data).' },
    { path: 'Files.Glob', detail: 'func(string) []string', documentation: 'File names matching a glob pattern, e.g. .Files.Glob "**.yaml".' },
    { path: 'Files.Lines', detail: 'func(string) []string', documentation: 'File content split into lines.' },
    { path: 'Files.AsConfig', detail: 'func([]string) string', documentation: 'File list as a ConfigMap-friendly base64 blob.' },
    { path: 'Files.AsSecrets', detail: 'func([]string) string', documentation: 'File list as a Secret-friendly base64 blob.' },
];

/** Exact builtin entry for a dotted path like `Chart.Name`, or null. */
export function chartBuiltinOf(path: string): ChartBuiltin | null {
    return CHART_BUILTINS.find(entry => entry.path === path) ?? null;
}

/* -------------------- chart values.yaml lookup -------------------- */

/** Default value for a dotted values key from the chart's values.yaml, or null when the key is absent. */
export function chartValuePreview(context: ChartTemplateContext, key: string): string | null {
    if (!context.valuesTree) return null;
    const separator = key.includes('\u001f') ? '\u001f' : '.';
    const segments = key.split(separator).filter(segment => segment.length > 0);
    let node: YNode | null = null;
    for (const doc of context.valuesTree.docs) {
        if (doc.root && doc.root.kind === 'mapping') { node = doc.root; break; }
    }
    for (const segment of segments) {
        if (!node || node.kind !== 'mapping') return null;
        const pair = mappingGet(node, segment);
        if (!pair) return null; // absent key
        node = pair.value; // null when the mapping has `key:` with no value
    }
    if (!node) return '(empty)';
    if (node.kind === 'scalar') return scalarPathText(node) || '(empty)';
    return node.kind === 'sequence' ? '(list)' : '(mapping)';
}
