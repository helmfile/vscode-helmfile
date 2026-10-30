/**
 * Parsed Helm repository index. Port of HelmfileChartIndex from the IntelliJ
 * plugin. Versions are de-duplicated and sorted newest-first.
 */

import { parse } from 'yaml';

export interface ChartEntry {
    readonly name: string;
    readonly version: string;
    readonly description: string;
    readonly deprecated: boolean;
}

export class ChartIndex {
    constructor(readonly charts: ReadonlyMap<string, readonly ChartEntry[]>) {}

    static parse(text: string): ChartIndex {
        let loaded: unknown;
        try {
            loaded = parse(text, { logLevel: 'silent' });
        } catch (error) {
            throw new Error('Invalid Helm repository index: ' + previewError(error));
        }
        if (typeof loaded !== 'object' || loaded === null) throw new Error('Not a Helm v1 repository index');
        const root = loaded as Record<string, unknown>;
        if (root.apiVersion !== 'v1' || typeof root.entries !== 'object' || root.entries === null) {
            throw new Error('Not a Helm v1 repository index');
        }
        const charts = new Map<string, readonly ChartEntry[]>();
        for (const [name, versions] of Object.entries(root.entries as Record<string, unknown>)) {
            if (!Array.isArray(versions)) throw new Error('Invalid chart entries in repository index');
            const unique = new Map<string, ChartEntry>();
            for (const item of versions) {
                if (typeof item !== 'object' || item === null) throw new Error('Invalid chart version in repository index');
                const chart = item as Record<string, unknown>;
                if (typeof chart.version !== 'string') throw new Error('Invalid chart version in repository index');
                const description = chart.description == null ? '' : String(chart.description).replace(/\s+/g, ' ');
                if (!unique.has(chart.version)) {
                    unique.set(chart.version, { name, version: chart.version, description, deprecated: chart.deprecated === true });
                }
            }
            const sorted = [...unique.values()].sort((left, right) => compareVersions(right.version, left.version));
            if (sorted.length) charts.set(name, sorted);
        }
        return new ChartIndex(charts);
    }

    static oci(chart: string, versions: string[]): ChartIndex {
        const entries = versions
            .map(version => ({ name: chart, version, description: 'OCI chart', deprecated: false }))
            .sort((left, right) => compareVersions(right.version, left.version));
        return new ChartIndex(new Map([[chart, entries]]));
    }

    containsVersion(chart: string, version: string): boolean {
        return (this.charts.get(chart) ?? []).some(candidate => normalized(candidate.version) === normalized(version));
    }
}

function normalized(version: string): string {
    return version.replace(/^v/, '').replace(/\+.*$/, '');
}

function previewError(error: unknown): string {
    return error instanceof Error ? error.message.split('\n')[0] : String(error);
}

/** Version ordering close to IntelliJ's VersionComparatorUtil for semver strings. */
export function compareVersions(left: string, right: string): number {
    const a = parseVersion(left);
    const b = parseVersion(right);
    for (let i = 0; i < 3; i++) {
        if (a.numbers[i] !== b.numbers[i]) return (a.numbers[i] ?? 0) - (b.numbers[i] ?? 0);
    }
    // A release sorts after any pre-release of the same numbers.
    if (!a.prerelease && b.prerelease) return 1;
    if (a.prerelease && !b.prerelease) return -1;
    if (a.prerelease && b.prerelease) return a.prerelease.localeCompare(b.prerelease);
    return 0;
}

function parseVersion(version: string): { numbers: number[]; prerelease: string | null } {
    const text = version.replace(/^v/, '').replace(/\+.*$/, '');
    const match = /^(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:[-.]?([0-9A-Za-z.-]+))?$/.exec(text);
    if (!match) return { numbers: [0, 0, 0], prerelease: text || null };
    return {
        numbers: [Number(match[1] ?? 0), Number(match[2] ?? 0), Number(match[3] ?? 0)],
        prerelease: match[4] ?? null,
    };
}
