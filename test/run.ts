/**
 * Functional tests for the extension's core modules, driven by the same
 * example helmfile state the IntelliJ plugin ships. Runs under plain Node
 * with the vscode mock — no extension host, no cluster, no apply/sync.
 */
import * as path from 'node:path';
import * as fs from 'node:fs';
import * as vscode from 'vscode';
import { TemplateScanner } from '../src/templateScanner';
import { templateBlocks } from '../src/inspection';
import { allFunctions, findFunction } from '../src/functionCatalog';
import { readSource, stateFor, valuesModel, allDefinitions, childKeys, resolveValueFiles, SEPARATOR, bumpContentVersion } from '../src/values';
import { repositoryModel, query, alias } from '../src/repositories';
import { ChartIndex, compareVersions } from '../src/chartIndex';
import { parseTemplateOutput, parseDiffOutput, diffPartial } from '../src/outputs';
import { commandProblem, buildCommand, protectionProblem, isProtectedEnvironment, selectorOf } from '../src/execution';
import { valuePathAt } from '../src/references';
import { schemaContext } from '../src/schema';
import { parseCompletionPath } from '../src/yamlTree';

const EXAMPLES = path.resolve(__dirname, '../examples');
const STATE = vscode.Uri.file(path.join(EXAMPLES, 'helmfile.yaml.gotmpl'));

let failures = 0;
let checks = 0;
function check(name: string, ok: boolean, detail = ''): void {
    checks++;
    if (!ok) {
        failures++;
        console.log(`FAIL ${name}${detail ? ' :: ' + detail : ''}`);
    }
}
function eq(actual: unknown, expected: unknown, name: string): void {
    check(name, actual === expected, `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

// ---------------------------------------------------------------- scanner
{
    const source = readSource(STATE)!;
    check('readSource(example)', source != null && source.text.length > 0);
    const actions = TemplateScanner.scan(source.text);
    check('scanner finds actions', actions.length > 10, `count=${actions.length}`);
    check('all actions closed', actions.every(a => a.closed), JSON.stringify(actions.filter(a => !a.closed).slice(0, 2)));
    const masked = TemplateScanner.mask(source.text);
    eq(masked.length, source.text.length, 'mask preserves length');
    check('mask blanks actions', !masked.includes('{{'));
    const inner = source.text.indexOf('.StateValues.namespace');
    check('at() inside action', TemplateScanner.at(source.text, inner) != null);
    check('at() outside action', TemplateScanner.at(source.text, source.text.indexOf('releases:')) == null);
}

// ---------------------------------------------------------------- schema
{
    const source = readSource(STATE)!;
    eq(schemaContext(['releases']), 'releases', 'schemaContext(releases)');
    eq(schemaContext(['repositories']), 'repositories', 'schemaContext(repositories)');
    eq(schemaContext(['releases', 'dependencies']), 'dependencies', 'schemaContext(dependencies)');
    eq(schemaContext(['environments', 'prod']), 'environment', 'schemaContext(environment)');
    eq(schemaContext(['templates', 'simple']), 'releases', 'schemaContext(templates.x)');
    // completion path: caret on the key of a list item
    const at = source.text.indexOf('- name: oauth2-proxy') + '- '.length;
    eq(parseCompletionPath(source.text, at)?.join('/'), 'repositories', 'completionPath in repositories item');
    const releaseAt = source.text.indexOf('- name: fluentbit') + '- '.length;
    eq(parseCompletionPath(source.text, releaseAt)?.join('/'), 'releases', 'completionPath in releases item');
    const envAt = source.text.indexOf('environments:');
    eq(parseCompletionPath(source.text, envAt + 2)?.length, 0, 'completionPath at root key');
    eq(parseCompletionPath(source.text, source.text.indexOf('chart: charts/') + 'chart: charts'.length), null, 'completionPath on value');
}

// ---------------------------------------------------------------- values
{
    const model = valuesModel(STATE, 'prod')!;
    check('valuesModel(prod)', model != null);
    const namespace = model.definitions.get(['namespace'].join(SEPARATOR));
    check('prod namespace = prod', namespace?.preview === 'prod', `preview=${namespace?.preview}`);
    eq(model.environments.size, 3, 'model environments count (default+prod+preprod)');
    check('environments include default/prod/preprod', model.environments.has('default') && model.environments.has('prod') && model.environments.has('preprod'));

    const defaults = valuesModel(STATE, 'default')!;
    check('default env falls back to completion definitions', defaults.completionDefinitions.length > 0);
    const utils = defaults.completionDefinitions.filter(d => d.path === ['versions', 'utils'].join(SEPARATOR));
    check('versions.utils from undeclared envs', utils.length === 2 && utils.every(d => d.environment != null), JSON.stringify(utils.map(d => d.preview + '/' + d.environment)));

    const all = allDefinitions(STATE, 'prod');
    const storage = all.filter(d => d.path === ['versions', 'storage'].join(SEPARATOR));
    check('allDefinitions spans envs (prod+preprod)', storage.length === 2 && storage.every(d => d.preview === '1.3.0'), JSON.stringify(storage.map(d => d.preview + '@' + d.environment)));

    const children = childKeys(defaults, ['versions'].join(SEPARATOR));
    check('childKeys(versions) → default/storage/utils', children.length === 3 && children.every(d => d.path.split(SEPARATOR).length === 2), JSON.stringify(children.map(d => d.path.split(SEPARATOR)[1])));

    // values file resolution: prod envPath k8s/prod → values/production.yaml
    const source = readSource(STATE)!;
    const envPath = source.text.indexOf('k8s/prod');
    check('example envPath found', envPath > 0);
    const files = resolveValueFiles(source, 'values/common.yaml', 'prod');
    eq(files.length, 1, 'resolveValueFiles common.yaml');
    check('resolved under values/', files[0]?.path.endsWith(path.join('values', 'common.yaml')) === true, files[0]?.path);
}

// ---------------------------------------------------------------- repositories
{
    const model = repositoryModel(STATE, 'prod');
    eq(model.entries.length, 3, 'repository entries');
    check('model incomplete (missing base.yaml)', model.incomplete === true);
    const oci = model.entries.find(r => r.name === 'spark-web-proxy');
    check('spark-web-proxy is OCI', oci?.access.oci === true && oci?.access.url === 'quay.io/okdp/charts', JSON.stringify(oci?.access));
    const http = model.entries.find(r => r.name === 'fluent-bit');
    check('fluent-bit http', http?.access.url.startsWith('https://'), http?.access.url);
    const ociQuery = query(STATE, 'spark-web-proxy/spark-web-proxy', 'prod');
    check('query maps OCI chart', ociQuery?.access.oci === true && ociQuery?.chart === 'spark-web-proxy', JSON.stringify(ociQuery && { url: ociQuery.access.url, chart: ociQuery.chart }));
    const httpQuery = query(STATE, 'fluent-bit/fluent-bit', 'prod');
    check('query maps HTTP chart', httpQuery?.access.name === 'fluent-bit' && httpQuery?.chart === '', JSON.stringify(httpQuery && { name: httpQuery.access.name, chart: httpQuery.chart }));
    eq(alias(STATE, 'local-chart'), null, 'alias(local-chart)');
    eq(alias(STATE, 'fluent-bit/fluent-bit'), 'fluent-bit', 'alias(fluent-bit/...)');
}

// ---------------------------------------------------------------- chart index
{
    const index = ChartIndex.parse(`
apiVersion: v1
entries:
  fluent-bit:
    - name: fluent-bit
      version: 2.1.0
      description: old
    - name: fluent-bit
      version: v2.2.0+build.1
      description: new
      deprecated: false
`);
    const charts = index?.charts.get('fluent-bit') ?? [];
    eq(charts.length, 2, 'index dedupes/sorts entries');
    eq(charts[0]?.version, 'v2.2.0+build.1', 'newest first (raw version kept)');
    check('containsVersion normalizes v/+build', index?.containsVersion('fluent-bit', '2.2.0') === true);
    check('containsVersion misses unknown', index?.containsVersion('fluent-bit', '9.9.9') === false);
    eq(compareVersions('2.10.0', '2.9.0') > 0, true, 'numeric compare');
    let threw = false;
    try { ChartIndex.parse('not: [valid'); } catch { threw = true; }
    eq(threw, true, 'index parse failure throws');
}

// ---------------------------------------------------------------- outputs
{
    const template = parseTemplateOutput([
        '# Source: charts/utils/templates/cm.yaml',
        'apiVersion: v1',
        'kind: ConfigMap',
        'metadata:',
        '  name: shared',
        '  namespace: ops',
        '---',
        '# Source: charts/utils/templates/cm.yaml',
        'apiVersion: v1',
        'kind: ConfigMap',
        'metadata:',
        '  name: shared',
        '  namespace: ops',
        '--- # trailing comment',
        'apiVersion: v1',
        'kind: Secret',
        'metadata:',
        '  name: bare',
    ].join('\n') + '\n---\n');
    eq(template.resources.length, 3, 'template resources count');
    eq(template.resources[0].path, 'ops/ConfigMap/shared.yaml', 'namespaced resource path');
    check('duplicate gets suffix', template.resources[1].path === 'ops/ConfigMap/shared (2).yaml', template.resources[1].path);
    check('no-namespace bucket', template.resources[2].path.startsWith('_no-namespace/Secret/'), template.resources[2].path);
    eq(template.unrecognized, false, 'template output recognized');
    eq(parseTemplateOutput('not yaml: [').unrecognized, true, 'non-resource output flagged');
    eq(parseTemplateOutput('plain text').resources.length, 0, 'plain text has no resources');

    const diff = parseDiffOutput([
        'Comparing release=app, chart=app-0.1.0',
        'ns, app, Deployment (apps) has changed:',
        '  # Source: app/templates/deploy.yaml',
        '-  replicas: 1',
        '+  replicas: 2',
        '',
        'Comparing release=db, chart=db-0.1.0',
        'ns, db, Secret (v1) has been added:',
        '+  kind: Secret',
        '+  metadata:',
        '+    name: db',
        '',
        'Comparing release=gone, chart=gone-0.1.0',
        ', gone, Service (v1) has been removed:',
        '-  kind: Service',
        '',
        'Comparing release=quiet, chart=quiet-0.1.0',
        'ns, quiet, ConfigMap (v1) has changed, but diff is empty after suppression.',
        '',
        'helmfile: some progress line',
    ].join('\n'));
    eq(diff.resources.length, 4, 'diff resources count');
    eq(diff.resources[0].status, 'modified', 'modified status');
    eq(diff.resources[0].release, 'app', 'release tracked');
    check('added has empty before', diff.resources[1].status === 'added' && diff.resources[1].before === '', JSON.stringify(diff.resources[1].before));
    check('deleted keeps before, drops after', diff.resources[2].status === 'deleted' && diff.resources[2].after === '' && diff.resources[2].before.includes('Service'));
    check('cluster namespace bucket', diff.resources[2].namespace === '' , 'empty namespace group');
    eq(diff.resources[3].status, 'suppressed', 'suppressed status');
    check('unparsed progress captured', diff.unparsed.includes('helmfile: some progress line'), JSON.stringify(diff.unparsed));
    check('partial via unparsed', diffPartial(diff) === true);
    check('clean diff not partial', diffPartial(parseDiffOutput('ns, app, Deployment (apps) has changed:\n+  x: 1\n')) === false);
}

// ---------------------------------------------------------------- execution
{
    const spec = { file: '/states/helmfile.yaml', release: 'app', namespace: 'ns', environment: 'prod', operation: 'diff' as const };
    eq(commandProblem(spec), null, 'valid command');
    const built = buildCommand(spec);
    eq(built.args[0], '--file', 'diff argv starts with --file');
    check('diff flags', built.args.includes('diff') && built.args.includes('--detailed-exitcode') && built.args.includes('--output') && built.args.includes('diff'));
    eq(built.args[built.args.indexOf('--selector') + 1], selectorOf(spec), 'selector argument');
    check('diff env', built.env['HELM_DIFF_COLOR'] === 'false' && built.env['HELM_DIFF_OUTPUT_CONTEXT'] === '-1' && built.env['HELM_DIFF_TOOL'] === '');
    eq(buildCommand({ ...spec, release: '', operation: 'template' }).args.includes('--selector'), false, 'whole state has no selector');
    check('template subcommand', buildCommand({ ...spec, release: '', operation: 'template' }).args.includes('template'));
    check('destroy subcommand', buildCommand({ ...spec, release: '', operation: 'destroy' }).args.includes('destroy'));
    eq(built.cwd, '/states', 'cwd is state dir');
    check('bad release rejected', commandProblem({ ...spec, release: 'a b' }) != null);
    check('bad env rejected', commandProblem({ ...spec, environment: 'two words' }) != null);
    eq(protectionProblem('prod.*'), null, 'valid protection regex');
    check('invalid regex rejected', protectionProblem('(') != null);
    eq(isProtectedEnvironment('prod', 'prod.*'), true, 'prod protected');
    eq(isProtectedEnvironment('preprod', 'prod.*'), false, 'preprod not protected (full match)');
    eq(isProtectedEnvironment('anything', ''), false, 'empty regex disables');
}

// ---------------------------------------------------------------- references + catalog
{
    const text = 'namespace: {{ .StateValues.namespace }}';
    const ref = valuePathAt(text, text.indexOf('namespace }}') - 3);
    check('valuePathAt .StateValues', ref != null && ref.key === ['namespace'].join(SEPARATOR), JSON.stringify(ref));
    const indexRef = valuePathAt('{{ index .Values "image-tag" }}', 12);
    check('valuePathAt index quoted key', indexRef != null && indexRef.key === ['image-tag'].join(SEPARATOR), JSON.stringify(indexRef));
    eq(valuePathAt('key: value', 5), null, 'valuePathAt outside action');

    eq(findFunction('toYaml')?.family, 'Helmfile', 'catalog toYaml');
    eq(findFunction('b64enc')?.family, 'Sprig', 'catalog b64enc');
    eq(findFunction('printf')?.family, 'Go template', 'catalog printf');
    let count = 0;
    for (const _ of allFunctions()) count++;
    check('catalog size >= 90', count >= 90, String(count));
    eq(findFunction('nope'), undefined, 'catalog miss');
}

// ---------------------------------------------------------------- state discovery
{
    const nested = vscode.Uri.file(path.join(EXAMPLES, 'values', 'common.yaml'));
    const state = stateFor(nested);
    check('stateFor walks up from values/', state?.uri.path.endsWith('helmfile.yaml.gotmpl') === true, state?.uri.path);
    eq(stateFor(vscode.Uri.file('/tmp/other.yaml')), null, 'stateFor unrelated file');
}

// ---------------------------------------------------------------- dirty-cache invariant
{
    const before = valuesModel(STATE, 'prod')!;
    const changed = before.definitions.get(['namespace'].join(SEPARATOR));
    check('baseline before bump', changed != null);
    bumpContentVersion();
    const model = valuesModel(STATE, 'prod')!;
    check('model rebuilt after bump', model !== before);
}

// ---------------------------------------------------------------- template blocks
{
    const blocks = (text: string): { message: string }[] => {
        const out: { message: string }[] = [];
        templateBlocks(text, out as vscode.Diagnostic[]);
        return out;
    };
    eq(blocks('{{ if .Values.a }}x{{ end }}').length, 0, 'balanced if/end');
    eq(blocks('{{ range $i, $v := .list }}{{ else }}{{ end }}').length, 0, 'range with else');
    eq(blocks('{{ if .a }}{{ else if .b }}y{{ end }}').length, 0, 'else if reuses end');
    eq(blocks('{{ define "x" }}{{ end }}{{ block "y" . }}{{ end }}').length, 0, 'define and block');
    eq(blocks('{{ with .a }}{{ end }}{{/* comment */}}').length, 0, 'with + comment action');
    const unclosed = blocks('{{ if .Values.a }}x');
    check('unclosed if flagged', unclosed.length === 1 && unclosed[0].message.includes('Unclosed Go template block'), JSON.stringify(unclosed));
    const strayEnd = blocks('plain text {{ end }}');
    check('stray end flagged', strayEnd.length === 1 && strayEnd[0].message.includes('without a matching'), JSON.stringify(strayEnd));
    const strayElse = blocks('{{ define "x" }}{{ else }}{{ end }}');
    check('else outside if/range/with flagged', strayElse.length === 1 && strayElse[0].message.includes('outside of an'), JSON.stringify(strayElse));
    eq(blocks('{{ if .a').length, 0, 'unclosed action not double-reported as block');
    eq(blocks('{{ if .a }}x{{ end }} tail').length, 0, 'balanced with trailing text');
}

console.log(`\n${checks - failures}/${checks} checks passed`);
process.exit(failures === 0 ? 0 : 1);
