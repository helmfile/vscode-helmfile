/**
 * Helmfile state-file field catalog. Port of HelmfileSchema from the
 * IntelliJ plugin.
 */

import { parseCompletionPath } from './yamlTree';

export interface Field {
    readonly name: string;
    readonly type: string;
    readonly description: string;
}

const CHART_DEPENDENCIES_REFERENCE =
    'https://helmfile.readthedocs.io/en/latest/advanced-features/#adding-dependencies-without-forking-the-chart';
const REFERENCE = 'https://helmfile.readthedocs.io/en/stable/configuration/';

const SCHEMA = new Map<string, Field[]>();

fields(
    '',
    `
repositories|list|Chart repositories available to releases.
releases|list|Helm releases managed by this state file.
environments|map|Named environments and their state values.
values|list|State values files or inline maps exposed through .Values.
bases|list|State files merged before this state file, in order.
helmfiles|list|Nested Helmfile states or path specifications.
helmDefaults|map|Default Helm options inherited by releases.
templates|map|Reusable release specifications, usually referenced with YAML anchors or inherit.
commonLabels|map|Labels applied to every release.
missingFileHandler|string|How to handle missing referenced files: Error, Warn, Info, or Debug.
kubeContext|string|Kubernetes context used for this state.
namespace|string|Default release namespace.
apiVersions|list|Kubernetes API versions used during templating.
kubeVersion|string|Kubernetes version used during templating.
lockFilePath|string|Custom path for the Helmfile lock file.
`
);

fields(
    'releases',
    `
name|string|Helm release name.
chart|string|Repository/chart name, local chart directory, or OCI URL.
version|string|Chart version or version constraint.
namespace|string|Kubernetes namespace for the release.
kubeContext|string|Kubernetes context for the release.
values|list|Chart values passed to Helm; these do not define Helmfile's .Values.
secrets|list|Encrypted chart values files decrypted by helm-secrets.
set|list|Individual Helm values with name and value fields.
setString|list|Individual Helm values forced to strings.
setFile|list|Individual Helm values read from files.
labels|map|Release labels used by Helmfile selectors.
installed|bool|Whether the release should be installed.
condition|string|Boolean state values path controlling the release.
dependencies|list|Additional chart dependencies added to this release's chart without forking it; each entry supports chart, version, and alias.
needs|list|Release dependencies, optionally qualified by context and namespace.
hooks|list|Commands executed on Helmfile lifecycle events.
inherit|list|Release templates to inherit.
missingFileHandler|string|Behavior for missing values files.
createNamespace|bool|Create the namespace if it does not exist.
wait|bool|Wait for Kubernetes resources to become ready.
waitForJobs|bool|Wait for Jobs when wait is enabled.
timeout|int|Helm operation timeout in seconds.
atomic|bool|Roll back a failed upgrade; implies wait.
cleanupOnFail|bool|Delete newly created resources on upgrade failure.
force|bool|Use replacement when upgrading resources.
verify|bool|Verify the chart before installation.
devel|bool|Allow development chart versions.
skipDeps|bool|Skip chart dependency updates.
skipDiffValidation|bool|Skip validation during diff.
disableValidation|bool|Disable validation during diff.
disableOpenAPIValidation|bool|Disable OpenAPI schema validation.
historyMax|int|Maximum number of release revisions to retain.
reuseValues|bool|Reuse values from the previous release.
resetValues|bool|Reset release values to chart defaults on upgrade.
transformers|list|Kustomize transformers applied to rendered manifests.
strategicMergePatches|list|Strategic merge patches applied to manifests.
jsonPatches|list|JSON patches applied to manifests.
`
);

fields(
    'dependencies',
    `
chart|string|Dependency chart: repository/chart, local chart path, OCI reference, or go-getter URL.
version|string|Version or version constraint for the dependency chart.
alias|string|Alternative name for this chart dependency; allows multiple instances of the same chart.
`,
    CHART_DEPENDENCIES_REFERENCE
);

fields(
    'repositories',
    `
name|string|Repository alias used in chart names.
url|string|Helm repository URL.
oci|bool|Treat this repository as an OCI registry.
username|string|Repository authentication username.
password|string|Repository authentication password.
registryConfig|string|Path to Helm registry authentication configuration.
managed|string|How Helmfile manages this repository.
certFile|string|TLS client certificate file.
keyFile|string|TLS client key file.
caFile|string|CA certificate file.
skipTLSVerify|bool|Skip TLS certificate verification.
passCredentials|bool|Forward repository credentials to other domains.
plainHttp|bool|Connect to the repository or OCI registry over plain HTTP.
verify|bool|Verify chart provenance from this repository.
keyring|string|Keyring used to verify chart provenance.
`
);

fields(
    'environment',
    `
values|list|YAML, templated YAML, HCL files, or inline state values for this environment.
secrets|list|Encrypted state values files.
kubeContext|string|Kubernetes context for the environment.
missingFileHandler|string|Behavior for missing environment files.
missingFileHandlerConfig|map|Additional missing-file behavior.
`
);

fields(
    'hooks',
    `
events|list|Lifecycle events such as prepare, presync, postsync, or cleanup.
command|string|Executable to run.
args|list|Command arguments, which may contain templates.
showlogs|bool|Show hook command output.
`
);

fields(
    'set',
    `
name|string|Dotted Helm values key.
value|any|Value assigned to the Helm key.
file|string|File whose content supplies this Helm value.
values|list|Array value assigned to the Helm key.
`
);

fields(
    'helmfiles',
    `
path|string|Nested state file path or glob.
selectors|list|Release selectors forwarded to the nested state.
selectorsInherited|bool|Inherit parent release selectors.
values|list|Additional state values passed to the nested state.
`
);

fields(
    'inherit',
    `
template|string|Name of a release template to inherit.
except|list|Fields excluded from inheritance.
`
);

SCHEMA.set(
    'helmDefaults',
    SCHEMA.get('releases')!.filter(field =>
        new Set([
            'kubeContext',
            'createNamespace',
            'wait',
            'waitForJobs',
            'timeout',
            'atomic',
            'cleanupOnFail',
            'force',
            'verify',
            'devel',
            'skipDeps',
            'historyMax',
            'reuseValues',
            'resetValues',
            'disableOpenAPIValidation',
        ]).has(field.name)
    )
);

function fields(context: string, rows: string, reference: string = REFERENCE): void {
    SCHEMA.set(
        context,
        rows
            .trim()
            .split('\n')
            .map(row => {
                const cells = row.split('|', 3);
                return { name: cells[0], type: cells[1], description: cells[2], reference } as Field & { reference: string };
            })
    );
}

export function schemaFields(context: string): Field[] {
    return SCHEMA.get(context) ?? [];
}

/** HelmfileSchema.context: schema bucket for a key path. */
export function schemaContext(path: string[]): string {
    if (path.length === 0) return '';
    const last = path[path.length - 1];
    if (path.length === 2 && path[0] === 'environments') return 'environment';
    if (path.length === 2 && path[0] === 'templates') return 'releases';
    if (
        last === 'dependencies' &&
        (equals(path, ['releases', 'dependencies']) || (path.length === 3 && path[0] === 'templates'))
    ) {
        return 'dependencies';
    }
    if (equals(path, ['releases']) || equals(path, ['repositories']) || equals(path, ['helmDefaults']) || equals(path, ['helmfiles'])) {
        return last;
    }
    if (path.length === 2 && path[0] === 'releases') {
        if (last === 'hooks' || last === 'inherit') return last;
        if (last === 'set' || last === 'setString' || last === 'setFile') return 'set';
    }
    return 'unknown';
}

function equals(path: string[], expected: string[]): boolean {
    return path.length === expected.length && path.every((segment, index) => segment === expected[index]);
}

/** Mapping-key path of the line being typed at offset, or null outside key position. */
export function completionPath(text: string, offset: number): string[] | null {
    return parseCompletionPath(text, offset);
}
