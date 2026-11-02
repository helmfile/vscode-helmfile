/**
 * Functional tests for the extension's core modules, driven by the same
 * example helmfile state the IntelliJ plugin ships. Runs under plain Node
 * with the vscode mock — no extension host, no cluster, no apply/sync.
 */
import * as path from 'node:path';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as vscode from 'vscode';
import { TemplateScanner } from '../src/templateScanner';
import { templateBlocks, unclosedActions } from '../src/inspection';
import { unknownFieldDiagnostics, missingFileDiagnostics, repositoryDiagnostics, outdatedVersions } from '../src/inspection';
import { envVarSuggestions } from '../src/envVars';
import { chartValueKeys, chartValuePaths, chartValuesContextFor } from '../src/chartValues';
import { repositoryService } from '../src/repositoryService';
import { contextualCompletions } from '../src/contextualCompletion';
import { fillMaskedTemplateKeys } from '../src/templateScanner';
import { allFunctions, findFunction } from '../src/functionCatalog';
import { readSource, stateFor, valuesModel, allDefinitions, childKeys, resolveValueFiles, SEPARATOR, bumpContentVersion } from '../src/values';
import { repositoryModel, query, alias } from '../src/repositories';
import { ChartIndex, compareVersions } from '../src/chartIndex';
import { parseTemplateOutput, parseDiffOutput, diffPartial, OutputViewer, disposeOutputProvider } from '../src/outputs';
import { commandProblem, buildCommand, protectionProblem, isProtectedEnvironment, selectorOf } from '../src/execution';
import { valuePathAt } from '../src/references';
import { schemaContext } from '../src/schema';
import { parseCompletionPath, parseTree } from '../src/yamlTree';
import { tokenizeAction, SEMANTIC_TOKEN_TYPES, HelmfileSemanticTokensProvider } from '../src/semanticTokens';
import { helmfileSymbols } from '../src/documentSymbol';
import { HelmfileCodeActionProvider } from '../src/codeActions';

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

// ------------------------------------------------------- contextual completion
{
    const { parseTree } = require('../src/yamlTree') as typeof import('../src/yamlTree');
    const { fieldContextAt, releaseNames, contextualCompletions, kubeContexts, stateRelativeFiles } = require('../src/contextualCompletion') as typeof import('../src/contextualCompletion');
    const ctxText = [
        'releases:',
        '  - name: grafana',
        '    chart: grafana/grafana',
        '    needs:',
        '      - lo',
        '    condition: ',
        '    values:',
        '      - va',
        'templates:',
        '  logging:',
        '    chart: fluent-bit/fluent-bit',
        'environments:',
        '  production:',
        '    values: []',
    ].join('\n');
    const ctxSource = { uri: vscode.Uri.file(path.join(path.dirname(STATE.fsPath), 'helmfile.yaml')), text: ctxText, tree: parseTree(ctxText) };

    eq(releaseNames(ctxSource).join(','), 'grafana', 'releaseNames static');
    const needsOffset = ctxText.indexOf('- lo') + '- l'.length;
    const needsField = fieldContextAt(ctxSource, needsOffset);
    check('fieldContextAt resolves needs item', needsField?.key === 'needs' && needsField.path.includes('releases'), JSON.stringify(needsField));
    eq(needsField?.typed ?? '', 'l', 'needs typed text');
    const needsList = contextualCompletions(ctxSource, needsOffset, 'production');
    check('needs offers release names', needsList != null && needsList.items.some(i => i.label === 'grafana'), JSON.stringify(needsList?.items.map(i => i.label)));

    const conditionOffset = ctxText.indexOf('condition: ') + 'condition: '.length;
    const conditionList = contextualCompletions(ctxSource, conditionOffset, 'production');
    check('condition offers release flags', conditionList != null && conditionList.items.some(i => i.label === 'grafana.enabled'), JSON.stringify(conditionList?.items.map(i => i.label)));

    const valuesOffset = ctxText.indexOf('- va') + '- v'.length;
    const valuesField = fieldContextAt(ctxSource, valuesOffset);
    check('fieldContextAt resolves values item', valuesField?.key === 'values' && valuesField.path.includes('releases'), JSON.stringify(valuesField));
    const valuesList = contextualCompletions(ctxSource, valuesOffset, 'production');
    check('values offers files from disk', valuesList != null && valuesList.items.some(i => String(i.label).startsWith('values/')), JSON.stringify(valuesList?.items.slice(0, 3).map(i => i.label)));

    const inheritOffset = ctxText.indexOf('  logging:') + 3;
    const inheritSource = { ...ctxSource, text: ctxText.replace('    needs:\n      - lo', '    inherit:\n      - log'), tree: parseTree(ctxText.replace('    needs:\n      - lo', '    inherit:\n      - log')) };
    // template declarations resolve through the values module: register the
    // synthetic file as an open document, exactly like the real editor does.
    const { setOpenDocument, closeOpenDocument } = require('../src/values') as typeof import('../src/values');
    setOpenDocument(inheritSource.uri, 1, inheritSource.text);
    const inheritList = contextualCompletions(inheritSource, inheritSource.text.indexOf('- log') + 2, 'production');
    check('inherit offers template declarations', inheritList != null && inheritList.items.some(i => i.label === 'logging'), JSON.stringify(inheritList?.items.map(i => i.label)));
    closeOpenDocument(inheritSource.uri);

    const kubeFixture = path.join(fs.mkdtempSync('helmfile-kube-'), 'config');
    fs.writeFileSync(kubeFixture, 'contexts:\n  - name: zeta\n  - name: alpha\n');
    eq(kubeContexts([kubeFixture]).join(','), 'alpha,zeta', 'kubeContexts sorted');
    fs.rmSync(path.dirname(kubeFixture), { recursive: true, force: true });

    const files = stateRelativeFiles(STATE.fsPath, ['.yaml'], 'values/');
    check('stateRelativeFiles lists values dir', files.some(f => f.relative === 'values/common.yaml'), JSON.stringify(files.map(f => f.relative)));
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

    // Shared content provider (H1 regression): both viewers must serve their
    // documents through the single scheme-wide provider, and a new run of a
    // kind must evict only that kind's previous documents (M2).
    const templateViewer = new OutputViewer('template');
    const diffViewer = new OutputViewer('diff');
    const provider = (vscode as unknown as { _contentProviders: Map<string, { provideTextDocumentContent: (uri: { path: string }) => string }> })._contentProviders.get('helmfile-output');
    check('provider registered', provider != null);
    const doc = (label: string): string => provider.provideTextDocumentContent({ path: '/' + encodeURIComponent(label) });
    const manifest = ['apiVersion: v1', 'kind: ConfigMap', 'metadata:', '  name: m'].join('\n') + '\n';
    void templateViewer.showTemplate(parseTemplateOutput(manifest), 'default');
    void diffViewer.showDiff(parseDiffOutput('ns, app, Deployment (apps) has changed:\n+  x: 1\n'), 'release app', 'default');
    check('template doc served', doc('template:All manifests.yaml') === manifest, JSON.stringify(doc('template:All manifests.yaml')));
    check('diff doc served', doc('diff:all-before').includes('Deployment'), JSON.stringify(doc('diff:all-before')));
    const manifest2 = manifest.replace('name: m', 'name: m2');
    void templateViewer.showTemplate(parseTemplateOutput(manifest2), 'default');
    check('template rerun evicts old doc', doc('template:All manifests.yaml') === manifest2, JSON.stringify(doc('template:All manifests.yaml')));
    check('diff docs survive template rerun', doc('diff:all-before').includes('Deployment'), 'diff kind untouched');
    templateViewer.dispose();
    check('diff doc survives template viewer dispose', doc('diff:all-before').includes('Deployment'), 'dispose is per-kind');
    disposeOutputProvider();
    check('provider disposed clears docs', doc('diff:all-before') === '', 'shared store cleared');
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
    const actions = (text: string): { message: string }[] => {
        const out: { message: string }[] = [];
        unclosedActions(text, out as vscode.Diagnostic[]);
        return out;
    };
    eq(actions('{{}}').length, 1, 'empty action {{}} flagged');
    eq(actions('{{ }}').length, 1, 'blank action {{ }} flagged');
    eq(actions('{{- -}}').length, 1, 'trim-marker blank action flagged');
    check('empty action message', actions('{{ .x }}').length === 0 && actions('{{}}')[0].message.includes('Empty'), 'non-empty actions pass');
    eq(actions('routerInstances:  .Values | get "mysql.routerInstances" 2 }}').length, 1, 'orphan }} without {{ flagged');
    check('orphan message', actions('x: }}')[0].message.includes('Unmatched Go template closing'), 'orphan message text');
    eq(actions('a: {{ .x }}').length, 0, 'closed actions add no orphan warnings');
    eq(actions('{{ if .x }} tail }}').length, 1, '}} outside action span flagged once');
    eq(actions('}}}').length, 1, 'triple brace flagged once');
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

// ---------------------------------------------------------------- semantic tokens
{
    const text = 'releases:\n  - name: x\n    values:\n      - {{ if .Values.db.host }}{{ .Values.db.host | quote }}{{ end }}\n';
    const actions = TemplateScanner.scan(text);
    const tokens = actions.flatMap(action => tokenizeAction(text, action));
    const typeOf = (word: string): string | undefined =>
        tokens.find(token => text.slice(token.start, token.end) === word)?.type;
    eq(typeOf('if'), 'keyword', 'if is keyword');
    eq(typeOf('end'), 'keyword', 'end is keyword');
    eq(typeOf('quote'), 'function', 'sprig function');
    eq(typeOf('.Values.db.host'), 'property', 'dotted path');
    check('token legend ordered', SEMANTIC_TOKEN_TYPES.indexOf('function') > 0 && SEMANTIC_TOKEN_TYPES.length === 9, `${SEMANTIC_TOKEN_TYPES.length} types`);
    const str = tokenizeAction('a {{ "x}}y" }} b', TemplateScanner.scan('a {{ "x}}y" }} b')[0]);
    check('string with }} stays one token', str.length === 1 && str[0].type === 'string', JSON.stringify(str));
    const varCase = tokenizeAction('{{ $x := .a }}', TemplateScanner.scan('{{ $x := .a }}')[0]);
    check('$var is variable', varCase.some(t => t.type === 'variable' && t.end - t.start === 2), JSON.stringify(varCase));

    // Regression (extension host freeze): an unterminated string action token
    // (e.g. `{{ .Vaules | get """ }}`) spans the rest of the file including
    // newlines; the per-line split must always advance and never emit a token
    // that crosses or covers a newline.
    {
        const provider = new HelmfileSemanticTokensProvider();
        const cases: string[] = [
            'a:\n  b: {{ .Vaules | get """ }}\nc: more\nlast line no newline',
            'x: {{ "unterminated\nnext line\n}} more',
            'k: {{ `multi\nline` }}\nz: 1\n',
            'q: {{ """ }}\n', // third quote swallows everything incl. trailing \n
        ];
        let worst = 0;
        for (const text of cases) {
            const doc = { getText: () => text, uri: { fsPath: '/tmp/sem.yaml.gotmpl' } } as never;
            const t0 = Date.now();
            const result = provider.provideDocumentSemanticTokens(doc) as { data: number[] };
            const dt = Date.now() - t0;
            if (dt > worst) worst = dt;
            // decode delta-encoded tokens and validate line/col/length
            const lines = text.split('\n');
            let line = 0;
            let col = 0;
            for (let i = 0; i < result.data.length; i += 5) {
                line += result.data[i];
                col = result.data[i] === 0 ? col + result.data[i + 1] : result.data[i + 1];
                const len = result.data[i + 2];
                check('token within one line', col + len <= lines[line].length, `case=${JSON.stringify(text.slice(0, 24))} line=${line} col=${col} len=${len}`);
            }
        }
        check('semantic tokens terminate fast', worst < 2000, `worst=${worst}ms`);
    }
}

// ---------------------------------------------------------------- document symbols
{
    const symbols = helmfileSymbols(fs.readFileSync(path.join(EXAMPLES, 'helmfile.yaml.gotmpl'), 'utf8'));
    check('release symbols found', symbols.some(s => s.kind === 'release' && (s.name === 'fluentbit' || s.name === 'spark-web-proxy')), JSON.stringify(symbols.map(s => `${s.kind}:${s.name}`)));
    check('repository symbols found', symbols.some(s => s.kind === 'repository'), JSON.stringify(symbols.map(s => `${s.kind}:${s.name}`)));
    check('environment symbols found', symbols.some(s => s.kind === 'environment'), JSON.stringify(symbols.map(s => `${s.kind}:${s.name}`)));
    check('template symbols found', symbols.some(s => s.kind === 'template'), JSON.stringify(symbols.map(s => `${s.kind}:${s.name}`)));
    check('selection within range', symbols.every(s => s.selectionStart >= s.start && s.selectionEnd <= s.end), 'selection contained');
}

// ---------------------------------------------------------------- code actions
{
    const provider = new HelmfileCodeActionProvider();
    const mkDoc = (text: string): unknown => ({
        uri: vscode.Uri.file('/tmp/helmfile-test.yaml.gotmpl'),
        getText: () => text,
        lineAt: (line: number) => {
            const lines = text.split('\n');
            const content = lines[Math.min(line, lines.length - 1)] ?? '';
            return { range: { end: { line, character: content.length } }, text: content };
        },
    });
    const range = { start: { line: 0, character: 0 }, end: { line: 0, character: 2 }, intersection: (other: { start: { line: number } }) => other } as never;
    const diag = (message: string): { message: string; source: string; range: unknown } => ({ message, source: 'helmfile', range });
    const doc = mkDoc('a: {{}}') as never;
    const empty = provider.provideCodeActions(doc, range as never, { diagnostics: [diag('Empty Go template action: nothing between {{ and }}')] } as never) as { title: string; isPreferred?: boolean }[];
    check('empty action quick fix', empty.length === 1 && empty[0].title.startsWith('Delete empty') && empty[0].isPreferred === true, JSON.stringify(empty.map(a => a.title)));
    const orphan = provider.provideCodeActions(doc, range as never, { diagnostics: [diag('Unmatched Go template closing: no matching {{')] } as never) as { title: string }[];
    check('orphan quick fix', orphan.length === 1 && orphan[0].title === 'Delete orphan }}', JSON.stringify(orphan.map(a => a.title)));
    const unclosed = provider.provideCodeActions(doc, range as never, { diagnostics: [diag('Unclosed Go template action: expected }}')] } as never) as { title: string }[];
    check('unclosed quick fix', unclosed.length === 1 && unclosed[0].title.startsWith('Insert }}'), JSON.stringify(unclosed.map(a => a.title)));
    const refresh = provider.provideCodeActions(doc, range as never, { diagnostics: [{ ...diag('Chart was not found'), code: 'helmfile.refreshRepositories' }] } as never) as { title: string }[];
    check('refresh quick fix', refresh.length === 1 && refresh[0].title.startsWith('Refresh'), JSON.stringify(refresh.map(a => a.title)));
}

// ---------------------------------------------------------------- masked template keys
// d7y-style states generate whole mapping keys from templates:
// `  {{ $key }}:` under `environments:` masked to a blank key previously
// produced "All mapping items must start at the same column" false positives.
{
    const d7y = [
        '# A workaround for https://github.com/roboll/helmfile/issues/1045',
        'environments:',
        '{{ $environments := (readFile "bases/environments.yaml" | fromYaml) }}',
        '{{ range $key, $env := (index $environments "environments") }}',
        '  {{ $key }}:',
        '    values:',
        '      - "environments/{{ $key }}/*.yaml.gotmpl"',
        '{{- end }}',
        '',
        'helmfiles:',
        '  - path: applications/dragonfly.yaml',
        '',
    ].join('\n');
    const { TemplateScanner } = require('../src/templateScanner') as typeof import('../src/templateScanner');
    const { parseTree } = require('../src/yamlTree') as typeof import('../src/yamlTree');
    const filled = fillMaskedTemplateKeys(TemplateScanner.mask(d7y));
    const errors = parseTree(filled).errors;
    eq(errors.length, 0, `no false YAML errors on template keys: ${JSON.stringify(errors.map(e => e.message))}`);
    const maskedLine = TemplateScanner.mask(d7y).split('\n')[4];
    const filledLine = filled.split('\n')[4];
    check(
        'filler keeps length + colon position',
        filledLine.length === maskedLine.length && filledLine.endsWith(':') && /^x+:$/.test(filledLine),
        `${JSON.stringify(maskedLine)} -> ${JSON.stringify(filledLine)}`,
    );
    // A deliberately broken document still reports the genuine error.
    const broken = fillMaskedTemplateKeys(TemplateScanner.mask('a: 1\n  b: 2'));
    check('genuine YAML errors still reported', parseTree(broken).errors.length > 0, 'expected error');
}

// ------------------------------------------------------------ project entry
{
    const { detectProject, projectFor, isStateFileName, projectScope } = require('../src/project') as typeof import('../src/project');
    const tempRoot = fs.mkdtempSync('helmfile-proj-');
    try {
        eq(detectProject(tempRoot), null, 'empty dir: no project');

        const single = path.join(tempRoot, 'single');
        fs.mkdirSync(single);
        fs.writeFileSync(path.join(single, 'helmfile.yaml'), 'releases: []\n');
        const p1 = detectProject(single)!;
        check('helmfile.yaml entry', p1.entries.length === 1 && p1.entries[0].endsWith('helmfile.yaml') && p1.kind === 'file' && p1.conflict === null, JSON.stringify(p1));

        const gotmpl = path.join(tempRoot, 'gotmpl');
        fs.mkdirSync(gotmpl);
        fs.writeFileSync(path.join(gotmpl, 'helmfile.yaml.gotmpl'), 'releases: []\n');
        const p2 = detectProject(gotmpl)!;
        check('helmfile.yaml.gotmpl fallback entry', p2.entries.length === 1 && p2.entries[0].endsWith('helmfile.yaml.gotmpl'), JSON.stringify(p2));

        const both = path.join(tempRoot, 'both');
        fs.mkdirSync(both);
        fs.writeFileSync(path.join(both, 'helmfile.yaml'), 'releases: []\n');
        fs.writeFileSync(path.join(both, 'helmfile.yaml.gotmpl'), 'releases: []\n');
        const p3 = detectProject(both)!;
        check('yaml + gotmpl conflict', p3.conflict != null && p3.conflict.includes('refuses'), p3.conflict);

        const dirBased = path.join(tempRoot, 'dirbased');
        fs.mkdirSync(path.join(dirBased, 'helmfile.d'), { recursive: true });
        fs.writeFileSync(path.join(dirBased, 'helmfile.d', '20-apps.yaml'), 'releases: []\n');
        fs.writeFileSync(path.join(dirBased, 'helmfile.d', '10-infra.yml'), 'releases: []\n');
        fs.writeFileSync(path.join(dirBased, 'helmfile.d', '30-misc.yaml.gotmpl'), 'releases: []\n');
        fs.writeFileSync(path.join(dirBased, 'helmfile.d', 'README.md'), 'not a state\n');
        const p4 = detectProject(dirBased)!;
        check(
            'helmfile.d sorted entries',
            p4.kind === 'directory' && p4.entries.map(e => path.basename(e)).join(',') === '10-infra.yml,20-apps.yaml,30-misc.yaml.gotmpl',
            JSON.stringify(p4.entries.map(e => path.basename(e))),
        );

        const dirConflict = path.join(tempRoot, 'dirconflict');
        fs.mkdirSync(path.join(dirConflict, 'helmfile.d'), { recursive: true });
        fs.writeFileSync(path.join(dirConflict, 'helmfile.yaml'), 'releases: []\n');
        const p5 = detectProject(dirConflict)!;
        check('helmfile.d + default file conflict', p5.conflict != null && p5.conflict.includes('helmfile.d'), p5.conflict);

        // Nested file resolves up to the nearest project root.
        const nested = path.join(dirBased, 'helmfile.d', '20-apps.yaml');
        const up = projectFor(nested)!;
        check('projectFor walks up', up.root === dirBased && up.kind === 'directory', JSON.stringify(up));
        eq(projectFor(path.join(tempRoot, 'single', 'helmfile.yaml'))?.root, single, 'projectFor exact dir');
        eq(projectFor(path.join(tempRoot, 'elsewhere', 'x.yaml'), tempRoot), null, 'projectFor stops at boundary');
        eq(projectScope(path.join(dirBased, 'helmfile.d', '20-apps.yaml')), dirBased, 'projectScope = project root');
        eq(projectScope(path.join(tempRoot, 'orphan', 'a.yaml')), path.join(tempRoot, 'orphan'), 'projectScope falls back to file dir');

        check('state file names', isStateFileName('a.yaml') && isStateFileName('b.yml') && isStateFileName('c.yaml.gotmpl') && isStateFileName('d.yml.gotmpl') && !isStateFileName('README.md') && !isStateFileName('x.yaml.gotmpl2'), 'isStateFileName');
    } finally {
        fs.rmSync(tempRoot, { recursive: true, force: true });
    }
}

// ------------------------------------------------- dynamic environments
{
    const { inferEnvironments } = require('../src/environmentInference') as typeof import('../src/environmentInference');
    const { environmentNames } = require('../src/values') as typeof import('../src/values');
    const d7yHead = [
        '# A workaround for https://github.com/roboll/helmfile/issues/1045',
        'environments:',
        '{{ $environments := (readFile "bases/environments.yaml" | fromYaml) }}',
        '{{ range $key, $env := (index $environments "environments") }}',
        '  {{ $key }}:',
        '    values:',
        '      - "environments/{{ $key }}/*.yaml.gotmpl"',
        '{{- end }}',
        '',
        'helmfiles:',
        '  - path: applications/dragonfly.yaml',
    ].join('\n');

    const temp = fs.mkdtempSync('helmfile-env-');
    try {
        fs.mkdirSync(path.join(temp, 'bases'), { recursive: true });
        fs.mkdirSync(path.join(temp, 'environments', 'dev'), { recursive: true });
        fs.mkdirSync(path.join(temp, 'environments', 'staging'), { recursive: true });
        fs.writeFileSync(path.join(temp, 'bases', 'environments.yaml'), 'environments:\n  dev:\n    values: [../environments/dev/*.yaml.gotmpl]\n  staging:\n    values: []\n');
        fs.writeFileSync(path.join(temp, 'helmfile.yaml.gotmpl'), d7yHead);

        const entry = vscode.Uri.file(path.join(temp, 'helmfile.yaml.gotmpl'));
        const source = { uri: entry, text: d7yHead, tree: parseTree(d7yHead) };
        const tier1 = inferEnvironments(source);
        check(
            'tier 1: readFile+fromYaml+index chain',
            tier1.length === 2 && tier1[0].name === 'dev' && tier1[1].name === 'staging' && tier1[0].origin === 'bases/environments.yaml',
            JSON.stringify(tier1),
        );

        const names = environmentNames(entry, 'default');
        check('environmentNames includes inferred', names.includes('dev') && names.includes('staging') && names.includes('default'), JSON.stringify(names));

        // Tier 2: unreadable source falls back to directory inference.
        fs.renameSync(path.join(temp, 'bases', 'environments.yaml'), path.join(temp, 'bases', 'environments.yaml.bak'));
        const tier2 = inferEnvironments({ uri: entry, text: d7yHead, tree: parseTree(d7yHead) });
        check(
            'tier 2: directory inference fallback',
            tier2.length === 2 && tier2.some(e => e.name === 'dev') && tier2.some(e => e.name === 'staging') && tier2[0].origin === 'environments/',
            JSON.stringify(tier2),
        );

        // Filename templates (not directory segments) must not infer.
        const filenameTemplate = d7yHead.replace('environments/{{ $key }}/*.yaml.gotmpl', 'values-{{ $key }}.yaml');
        fs.renameSync(path.join(temp, 'bases', 'environments.yaml.bak'), path.join(temp, 'bases', 'environments.yaml'));
        eq(inferEnvironments({ uri: entry, text: filenameTemplate, tree: parseTree(filenameTemplate) }).length, 2, 'filename template falls back to tier 1');

        eq(inferEnvironments({ uri: entry, text: 'releases: []\n', tree: parseTree('releases: []\n') }).length, 0, 'no environments mapping');
    } finally {
        fs.rmSync(temp, { recursive: true, force: true });
    }
}

// ------------------------------------------------- inferred environment lens
{
    const { HelmfileCodeLensProvider, HELMFILE_SELECT_ENVIRONMENT } = require('../src/codeLens') as typeof import('../src/codeLens');
    const { EnvironmentService } = require('../src/settings') as typeof import('../src/settings');
    const d7yHead = [
        'environments:',
        '{{ $environments := (readFile "bases/environments.yaml" | fromYaml) }}',
        '{{ range $key, $env := (index $environments "environments") }}',
        '  {{ $key }}:',
        '    values:',
        '      - "environments/{{ $key }}/*.yaml.gotmpl"',
        '{{- end }}',
        '',
        'helmfiles:',
        '  - path: applications/dragonfly.yaml',
    ].join('\n');
    const temp = fs.mkdtempSync('helmfile-lens-');
    try {
        fs.mkdirSync(path.join(temp, 'bases'), { recursive: true });
        fs.writeFileSync(path.join(temp, 'bases', 'environments.yaml'), 'environments:\n  dev: {}\n  prod: {}\n');
        const uri = vscode.Uri.file(path.join(temp, 'helmfile.yaml.gotmpl'));
        const document = {
            uri,
            getText: () => d7yHead,
            positionAt: (offset: number) => {
                const before = d7yHead.slice(0, offset);
                return new vscode.Position(before.split('\n').length - 1, offset - before.lastIndexOf('\n') - 1);
            },
        } as unknown as import('vscode').TextDocument;
        const provider = new HelmfileCodeLensProvider(
            new EnvironmentService({ workspaceState: { get: () => 'default', update: async () => undefined } } as unknown as import('vscode').ExtensionContext),
        );
        const lenses = provider.provideCodeLenses(document);
        const inferred = lenses.find(lens => lens.command?.title.includes('(inferred)'));
        check(
            'inferred environment lens on environments key',
            !!inferred && inferred.command!.command === HELMFILE_SELECT_ENVIRONMENT && inferred.command!.title.includes('dev') && inferred.command!.title.includes('prod'),
            JSON.stringify(lenses.map(l => l.command?.title)),
        );
    } finally {
        fs.rmSync(temp, { recursive: true, force: true });
    }
}

// ------------------------------------------------- conditional literal environments
{
    const { inferEnvironments } = require('../src/environmentInference') as typeof import('../src/environmentInference');
    const conditional = [
        'environments:',
        '  default:',
        '    values:',
        '      - "defaults.yaml"',
        '{{- if .Values | get "install.mysql_innodbcluster_d7y" false }}',
        '  mysql-innodbcluster:',
        '    values: []',
        '{{- end }}',
        '',
        'releases: []',
    ].join('\n');

    const write = (dir: string, flagValue: string | null) => {
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, 'helmfile.yaml.gotmpl'), conditional);
        fs.writeFileSync(
            path.join(dir, 'defaults.yaml'),
            flagValue === null ? 'other: 1\n' : `install:\n  mysql_innodbcluster_d7y: ${flagValue}\n`,
        );
    };

    // Flag true: the guarded literal entry is offered.
    {
        const temp = fs.mkdtempSync('helmfile-cond-');
        try {
            write(temp, 'true');
            const uri = vscode.Uri.file(path.join(temp, 'helmfile.yaml.gotmpl'));
            const result = inferEnvironments({ uri, text: conditional, tree: parseTree(conditional) }, 'default');
            check(
                'conditional entry offered when flag true',
                result.some(e => e.name === 'mysql-innodbcluster') && result.some(e => e.name === 'default'),
                JSON.stringify(result),
            );
        } finally {
            fs.rmSync(temp, { recursive: true, force: true });
        }
    }

    // Flag absent, default false: the guarded entry is suppressed.
    {
        const temp = fs.mkdtempSync('helmfile-cond-');
        try {
            write(temp, null);
            const uri = vscode.Uri.file(path.join(temp, 'helmfile.yaml.gotmpl'));
            const result = inferEnvironments({ uri, text: conditional, tree: parseTree(conditional) }, 'default');
            check(
                'conditional entry suppressed when default false',
                !result.some(e => e.name === 'mysql-innodbcluster') && result.some(e => e.name === 'default'),
                JSON.stringify(result),
            );
        } finally {
            fs.rmSync(temp, { recursive: true, force: true });
        }
    }

    // Unresolvable condition (no environment passed): offered, best-effort.
    {
        const temp = fs.mkdtempSync('helmfile-cond-');
        try {
            write(temp, null);
            const uri = vscode.Uri.file(path.join(temp, 'helmfile.yaml.gotmpl'));
            const result = inferEnvironments({ uri, text: conditional, tree: parseTree(conditional) });
            check('unresolvable condition offered best-effort', result.some(e => e.name === 'mysql-innodbcluster'), JSON.stringify(result));
        } finally {
            fs.rmSync(temp, { recursive: true, force: true });
        }
    }
}

// ------------------------------------------------- get-form value paths + expression hover
{
    const { evaluateExpressionAt } = require('../src/environmentInference') as typeof import('../src/environmentInference');

    const pipeForm = '{{- if .Values | get "install.mysql_innodbcluster_d7y" false }}';
    const pipeOffset = pipeForm.indexOf('.Values') + 2;
    const pipeRef = valuePathAt(pipeForm, pipeOffset);
    check(
        'valuePathAt get pipe form',
        pipeRef != null && pipeRef.key === ['install', 'mysql_innodbcluster_d7y'].join(SEPARATOR),
        JSON.stringify(pipeRef),
    );
    const callRef = valuePathAt('{{ get .Values "a.b" true }}', 8);
    check('valuePathAt get call form', callRef != null && callRef.key === ['a', 'b'].join(SEPARATOR), JSON.stringify(callRef));
    const quotedOffset = pipeForm.indexOf('mysql_innodbcluster_d7y');
    check('valuePathAt get quoted key cursor', valuePathAt(pipeForm, quotedOffset)?.key === ['install', 'mysql_innodbcluster_d7y'].join(SEPARATOR), 'quoted key cursor');

    const conditional = [
        'environments:',
        '  default:',
        '    values:',
        '      - "defaults.yaml"',
        '{{- if .Values | get "install.mysql_innodbcluster_d7y" false }}',
        '  mysql-innodbcluster:',
        '    values: []',
        '{{- end }}',
        '',
        'releases: []',
    ].join('\n');
    const write = (dir: string, body: string) => {
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, 'helmfile.yaml.gotmpl'), conditional);
        fs.writeFileSync(path.join(dir, 'defaults.yaml'), body);
    };
    const ifOffset = conditional.indexOf('.Values | get');

    {
        const temp = fs.mkdtempSync('helmfile-eval-');
        try {
            write(temp, 'install:\n  mysql_innodbcluster_d7y: true\n');
            const uri = vscode.Uri.file(path.join(temp, 'helmfile.yaml.gotmpl'));
            const evaluated = evaluateExpressionAt({ uri, text: conditional, tree: parseTree(conditional) }, ifOffset, 'default');
            check('evaluate get condition true', evaluated?.value.kind === 'text' && evaluated.value.text === 'true', JSON.stringify(evaluated));
        } finally {
            fs.rmSync(temp, { recursive: true, force: true });
        }
    }
    {
        const temp = fs.mkdtempSync('helmfile-eval-');
        try {
            write(temp, 'other: 1\n');
            const uri = vscode.Uri.file(path.join(temp, 'helmfile.yaml.gotmpl'));
            const evaluated = evaluateExpressionAt({ uri, text: conditional, tree: parseTree(conditional) }, ifOffset + 20, 'default');
            check(
                'evaluate get condition default false',
                evaluated?.value.kind === 'text' && evaluated.value.text === 'false' && evaluated.value.origin === 'default',
                JSON.stringify(evaluated),
            );
        } finally {
            fs.rmSync(temp, { recursive: true, force: true });
        }
    }

    // readFile/fromYaml chain with variable accumulation (d7y workaround head).
    {
        const temp = fs.mkdtempSync('helmfile-eval-');
        try {
            fs.mkdirSync(path.join(temp, 'bases'), { recursive: true });
            fs.writeFileSync(path.join(temp, 'bases/environments.yaml'), 'environments:\n  dev: {}\n  prod: {}\n');
            const text = [
                'environments:',
                '{{ $environments := (readFile "bases/environments.yaml" | fromYaml) }}',
                '{{ range $key, $env := (index $environments "environments") }}',
                '  {{ $key }}:',
                '{{- end }}',
            ].join('\n');
            const uri = vscode.Uri.file(path.join(temp, 'helmfile.yaml.gotmpl'));
            const rangeOffset = text.indexOf('index $environments');
            const evaluated = evaluateExpressionAt({ uri, text, tree: parseTree(text) }, rangeOffset, 'default');
            check(
                'evaluate range head via readFile chain',
                evaluated?.value.kind === 'mapping' && evaluated.value.mapping.pairs.length === 2,
                JSON.stringify(evaluated && (evaluated.value.kind === 'mapping' ? evaluated.value.mapping.pairs.map(p => p.key) : evaluated.value)),
            );
            // Hovering the {{- end }} action yields nothing.
            eq(evaluateExpressionAt({ uri, text, tree: parseTree(text) }, text.indexOf('{{- end }}') + 4, 'default'), null, 'evaluate end action null');
        } finally {
            fs.rmSync(temp, { recursive: true, force: true });
        }
    }
}

// ------------------------------------------------- dynamic environments values resolution
{
    const { valuesModel } = require('../src/values') as typeof import('../src/values');
    const stateText = [
        'environments:',
        '{{ $environments := (readFile "bases/environments.yaml" | fromYaml) }}',
        '{{ range $key, $env := (index $environments "environments") }}',
        '  {{ $key }}:',
        '    values:',
        '      - "environments/{{ $key }}/*.yaml"',
        '{{- end }}',
        '',
        'releases: []',
    ].join('\n');
    const temp = fs.mkdtempSync('helmfile-dynvals-');
    try {
        fs.mkdirSync(path.join(temp, 'bases'), { recursive: true });
        fs.mkdirSync(path.join(temp, 'environments/dev'), { recursive: true });
        fs.mkdirSync(path.join(temp, 'environments/prod'), { recursive: true });
        fs.writeFileSync(path.join(temp, 'helmfile.yaml.gotmpl'), stateText);
        fs.writeFileSync(path.join(temp, 'bases/environments.yaml'), 'environments:\n  dev: {}\n  prod: {}\n');
        fs.writeFileSync(path.join(temp, 'environments/dev/base.yaml'), 'install:\n  mysql: true\n');
        fs.writeFileSync(path.join(temp, 'environments/prod/base.yaml'), 'install:\n  mysql: false\n');
        const uri = vscode.Uri.file(path.join(temp, 'helmfile.yaml.gotmpl'));
        const dev = valuesModel(uri, 'dev');
        const devFlag = dev?.completionDefinitions.find(d => d.path === ['install', 'mysql'].join(SEPARATOR));
        check('dynamic env values resolve for dev', devFlag != null && devFlag.preview === 'true' && devFlag.environment === 'dev', JSON.stringify(devFlag));
        const prod = valuesModel(uri, 'prod');
        const prodFlag = prod?.definitions.get(['install', 'mysql'].join(SEPARATOR));
        check('dynamic env values resolve for prod', prodFlag != null && prodFlag.preview === 'false', JSON.stringify(prodFlag));
        // A values file beside the state inherits the rendered model.
        const valuesFile = vscode.Uri.file(path.join(temp, 'environments/dev/base.yaml'));
        const beside = allDefinitions(valuesFile, 'dev');
        check('values file inherits dynamic model', beside.some(d => d.path === ['install', 'mysql'].join(SEPARATOR)), JSON.stringify(beside.length));
    } finally {
        fs.rmSync(temp, { recursive: true, force: true });
    }
}

// ------------------------------------------------- disk edits invalidate caches
{
    const { valuesModel, bumpContentVersion } = require('../src/values') as typeof import('../src/values');
    const temp = fs.mkdtempSync('helmfile-invalidate-');
    try {
        fs.writeFileSync(path.join(temp, 'helmfile.yaml'), 'environments:\n  dev:\n    values:\n      - base.yaml\n');
        fs.writeFileSync(path.join(temp, 'base.yaml'), 'replicas: 1\n');
        const uri = vscode.Uri.file(path.join(temp, 'helmfile.yaml'));
        const before = valuesModel(uri, 'dev');
        check('model reads initial disk value', before?.definitions.get('replicas')?.preview === '1');
        // External edit (not open in an editor): the watcher bumps the
        // content version; the next model reads the new content.
        fs.writeFileSync(path.join(temp, 'base.yaml'), 'replicas: 2\n');
        bumpContentVersion();
        const after = valuesModel(uri, 'dev');
        check('model reflects disk edit after bump', after?.definitions.get('replicas')?.preview === '2');
    } finally {
        fs.rmSync(temp, { recursive: true, force: true });
    }
}

/* ---------------- review hardening regressions ---------------- */

// restore() must survive unreadable chart-cache entries without throwing.
{
    const { ChartSourceService } = require('../src/chartNavigation') as typeof import('../src/chartNavigation');
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'chart-cache-'));
    const previous = process.env['HELMFILE_CHART_CACHE'];
    process.env['HELMFILE_CHART_CACHE'] = root;
    try {
        // A plain file where a hash directory is expected: readdir fails with ENOTDIR.
        fs.writeFileSync(path.join(root, 'not-a-dir'), 'junk');
        // A valid cached chart.
        const dir = path.join(root, 'abc123', 'nginx');
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, '.helmfile-vscode-chart'), 'ingress-nginx/ingress-nginx@4.11.0');
        const service = new ChartSourceService();
        service.restore();
        const children = service.getChildren();
        check('chart cache restore skips broken entries', children.length === 1 && children[0].label === 'ingress-nginx/ingress-nginx@4.11.0');
        service.dispose();
    } finally {
        if (previous === undefined) delete process.env['HELMFILE_CHART_CACHE'];
        else process.env['HELMFILE_CHART_CACHE'] = previous;
        fs.rmSync(root, { recursive: true, force: true });
    }
}

// An unreadable helmfile.d/ must not break project detection.
{
    const { detectProject } = require('../src/project') as typeof import('../src/project');
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'helmfile-unreadable-'));
    try {
        const dir = path.join(temp, 'helmfile.d');
        fs.mkdirSync(dir);
        fs.writeFileSync(path.join(dir, 'apps.yaml'), 'releases: []\n');
        fs.chmodSync(dir, 0o000);
        try {
            const project = detectProject(temp);
            check('unreadable helmfile.d yields empty entries', project?.kind === 'directory' && project.entries.length === 0);
        } finally {
            fs.chmodSync(dir, 0o755);
        }
    } finally {
        fs.rmSync(temp, { recursive: true, force: true });
    }
}


// ------------------------------------------------------- review round 3 fixes
{
    // R1: version completions must be scoped to the target chart only.
    const { chartVersions } = require('../src/completion') as typeof import('../src/completion');
    const { ChartIndex } = require('../src/chartIndex') as typeof import('../src/chartIndex');
    const index: any = {
        charts: new Map<string, any[]>([
            ['fluent-bit', [{ name: 'fluent-bit', version: '3.1.0', description: '', deprecated: false }, { name: 'fluent-bit', version: '2.2.0', description: '', deprecated: true }]],
            ['postgres', [{ name: 'postgres', version: '16.0.0', description: '', deprecated: false }]],
        ]),
    } as unknown as ChartIndex;
    const httpRequest = { access: { name: 'fluent-bit', url: 'https://charts.example.com', oci: false }, chart: '' } as any;
    eq(chartVersions('fluent-bit/fluent-bit', httpRequest, index).map(e => e.version).join(','), '3.1.0,2.2.0', 'chartVersions scopes to the HTTP chart');
    const ociRequest = { access: { name: 'spark', url: 'registry.example.com/charts', oci: true }, chart: 'spark-web-proxy' } as any;
    eq(chartVersions('spark/spark-web-proxy', ociRequest, index).length, 0, 'chartVersions OCI uses request.chart (absent here)');
    eq(chartVersions('unknown/chart', httpQuery0(index), index).length, 0, 'chartVersions unknown chart is empty');

    // R5: only diff may run without a release (whole state).
    const { releaseInputProblem } = require('../src/operations') as typeof import('../src/operations');
    eq(releaseInputProblem('template', ''), 'Release name is required for this action', 'template rejects empty release');
    eq(releaseInputProblem('apply', '  '), 'Release name is required for this action', 'apply rejects blank release');
    eq(releaseInputProblem('destroy', ''), 'Release name is required for this action', 'destroy rejects empty release');
    eq(releaseInputProblem('diff', ''), null, 'diff allows whole state');

    // R3: template declaration cache survives only until content changes.
    const { bumpContentVersion } = require('../src/values') as typeof import('../src/values');
    const { templateDeclarations } = require('../src/templates') as typeof import('../src/templates');
    const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'helmfile-r3cache-'));
    try {
        const stateFile = path.join(cacheDir, 'helmfile.yaml');
        fs.writeFileSync(stateFile, 'templates:\n  first:\n    chart: a\n');
        const first = templateDeclarations(vscode.Uri.file(stateFile), 'default');
        check('cache sees first template', first.has('first') === true);
        fs.writeFileSync(stateFile, 'templates:\n  second:\n    chart: a\n');
        bumpContentVersion();
        const second = templateDeclarations(vscode.Uri.file(stateFile), 'default');
        check('cache invalidated on content change', second.has('second') === true && second.has('first') === false);
    } finally {
        fs.rmSync(cacheDir, { recursive: true, force: true });
    }

    // R7: condition completions include keys merged from environment values files.
    // R8: root `values:` list items complete file names; inline mappings do not.
    const { fieldContextAt, contextualCompletions } = require('../src/contextualCompletion') as typeof import('../src/contextualCompletion');
    const { readSource } = require('../src/values') as typeof import('../src/values');
    const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'helmfile-r3ctx-'));
    try {
        const statePath = path.join(projectDir, 'helmfile.yaml');
        const text = [
            'values:',
            '  - comm',
            'environments:',
            '  production:',
            '    values:',
            '      - values/env.yaml',
            'releases:',
            '  - name: app',
            '    chart: c',
            '    condition: ',
        ].join('\n');
        fs.writeFileSync(statePath, text);
        fs.mkdirSync(path.join(projectDir, 'values'));
        fs.writeFileSync(path.join(projectDir, 'values', 'env.yaml'), 'install:\n  mysql: true\n');
        fs.writeFileSync(path.join(projectDir, 'values', 'common.yaml'), 'a: 1\n');
        const source = readSource(vscode.Uri.file(statePath))!;
        const rootValuesOffset = text.indexOf('- comm') + '- co'.length;
        const rootValuesField = fieldContextAt(source, rootValuesOffset);
        check('root values list detected as sequence field', rootValuesField?.key === 'values' && rootValuesField.sequenceValue === true, JSON.stringify(rootValuesField));
        const rootValuesList = contextualCompletions(source, rootValuesOffset, 'production');
        check('root values list completes values files', rootValuesList != null && rootValuesList.items.some(i => String(i.label).startsWith('values/common.yaml')), JSON.stringify(rootValuesList?.items.slice(0, 3).map(i => i.label)));
        const inlineText = 'values:\n  key: va';
        const inlineSource = { uri: vscode.Uri.file(statePath), text: inlineText, tree: parseTree(inlineText) };
        const inlineField = fieldContextAt(inlineSource, inlineText.indexOf('key:') + 2);
        check('inline root values key is not a file list', inlineField?.key === 'key' && contextualCompletions(inlineSource, inlineText.indexOf('key:') + 2, 'production') === null, JSON.stringify(inlineField));
        const conditionOffset = text.indexOf('condition: ') + 'condition: '.length;
        const conditionList = contextualCompletions(source, conditionOffset, 'production');
        check('condition offers keys from values files', conditionList != null && conditionList.items.some(i => i.label === '.Values.install.enabled'), JSON.stringify(conditionList?.items.map(i => i.label)));
    } finally {
        fs.rmSync(projectDir, { recursive: true, force: true });
    }
}


function httpQuery0(_index: unknown): Parameters<typeof import('../src/completion').chartVersions>[1] {
    return { access: { name: 'fluent-bit', url: 'https://charts.example.com', oci: false }, chart: '' } as any;
}

// ---------------------------------------------------------------- env var completion (#3)
{
    process.env['HELMFILE_TEST_ENVVAR'] = 'unit-test-value';
    const suggestions = envVarSuggestions();
    const hit = suggestions.find(s => s.name === 'HELMFILE_TEST_ENVVAR');
    check('process env suggested for {{ env }}', hit != null && hit.value === 'unit-test-value' && hit.source === 'environment', JSON.stringify(hit));
    delete process.env['HELMFILE_TEST_ENVVAR'];
}

// ------------------------------------------------------- unknown field diagnostics (#9)
{
    const text = ['releases:', '  - name: app', '    chart: foo/bar', '    insatlled: true', '    installed: true'].join('\n');
    const source = { uri: vscode.Uri.file('/tmp/helmfile-unknown.yaml'), text, tree: parseTree(text) };
    const diagnostics: vscode.Diagnostic[] = [];
    unknownFieldDiagnostics(source, diagnostics);
    const unknown = diagnostics.find(d => d.message.includes("'insatlled'"));
    check('unknown release field flagged', unknown != null && unknown.message.includes('releases'), diagnostics.map(d => d.message).join('; '));
    check('known fields pass', !diagnostics.some(d => d.message.includes("'installed'")), diagnostics.map(d => d.message).join('; '));
    check('root keys unchecked', !diagnostics.some(d => d.message.includes("'releases'")), diagnostics.map(d => d.message).join('; '));
}

// ------------------------------------------------------- missing values file (#4)
{
    const dir = fs.mkdtempSync('helmfile-missing-');
    try {
        fs.writeFileSync(path.join(dir, 'values.yaml'), 'a: 1\n');
        const text = ['values:', '  - values.yaml', '  - values/nope.yaml', '  - "values/{{ .Environment.Name }}.yaml"', '  - values/*.yaml'].join('\n');
        const source = { uri: vscode.Uri.file(path.join(dir, 'helmfile.yaml')), text, tree: parseTree(text) };
        const diagnostics: vscode.Diagnostic[] = [];
        missingFileDiagnostics(source, 'default', diagnostics);
        const missing = diagnostics.find(d => d.message.includes('nope.yaml'));
        check('missing values file flagged', missing != null && missing.message.includes('Values file does not exist'), diagnostics.map(d => d.message).join('; '));
        check('existing file passes', !diagnostics.some(d => d.message.includes('values.yaml:')), diagnostics.map(d => d.message).join('; '));
        check('templated and glob paths skipped', diagnostics.length === 1, diagnostics.map(d => d.message).join('; '));
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
}

// ------------------------------------------------------- outdated version hint (#2)
{
    const dir = fs.mkdtempSync('helmfile-outdated-');
    try {
        const url = `https://charts-${Date.now()}.example.com`;
        const text = ['repositories:', '  - name: r', `    url: ${url}`, 'releases:', '  - name: app', '    chart: r/foo', '    version: 1.2.3'].join('\n');
        const statePath = path.join(dir, 'helmfile.yaml');
        fs.writeFileSync(statePath, text);
        const source = { uri: vscode.Uri.file(statePath), text, tree: parseTree(text) };
        repositoryService().remember({ access: { name: 'r', url, oci: false, username: '' }, chart: '' }, ChartIndex.parse('apiVersion: v1\nentries:\n  foo:\n    - version: 1.4.0\n    - version: 1.2.3\n'));
        const diagnostics: vscode.Diagnostic[] = [];
        repositoryDiagnostics(source, 'default', diagnostics);
        const outdated = diagnostics.find(d => d.code === 'helmfile.updateVersion');
        check('outdated version hinted', outdated != null && outdated.message.includes('1.4.0'), diagnostics.map(d => d.message).join('; '));
        check('quick fix target recorded', outdated != null && outdatedVersions.get(outdated) === '1.4.0', String(outdated && outdatedVersions.get(outdated)));
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
}

// ------------------------------------------------------- chart-aware values (#1)
{
    const dir = fs.mkdtempSync('helmfile-chartvalues-');
    try {
        fs.mkdirSync(path.join(dir, 'charts/mychart'), { recursive: true });
        fs.mkdirSync(path.join(dir, 'values'), { recursive: true });
        fs.writeFileSync(path.join(dir, 'charts/mychart/values.yaml'), 'image:\n  repository: nginx\n  tag: "1.0"\nreplicas: 2\n');
        fs.writeFileSync(path.join(dir, 'values/app.yaml.gotmpl'), 'image:\n  repository: myrepo\n');
        const text = ['releases:', '  - name: app', '    chart: ./charts/mychart', '    values:', '      - values/app.yaml.gotmpl', '    set:', '      - name: ', '        value: x'].join('\n');
        const statePath = path.join(dir, 'helmfile.yaml');
        fs.writeFileSync(statePath, text);

        const valuesUri = vscode.Uri.file(path.join(dir, 'values/app.yaml.gotmpl'));
        const context = chartValuesContextFor(valuesUri, 'default');
        check('values file resolves to its chart', context != null && context.chart === './charts/mychart' && context.tree != null, JSON.stringify(context && { chart: context.chart, hasTree: context.tree != null }));
        if (context) {
            const rootKeys = chartValueKeys(context, []);
            check('chart root keys offered', rootKeys.some(k => k.key === 'image' && k.preview === 'mapping') && rootKeys.some(k => k.key === 'replicas' && k.preview === '2'), JSON.stringify(rootKeys));
            const nested = chartValueKeys(context, ['image']);
            check('nested chart keys offered', nested.some(k => k.key === 'repository' && k.preview === 'nginx') && nested.some(k => k.key === 'tag' && k.preview === '1.0'), JSON.stringify(nested));
            const flatPaths = chartValuePaths(context);
            check('dotted set paths flattened', flatPaths.some(k => k.key === 'image.tag' && k.preview === '1.0') && flatPaths.some(k => k.key === 'replicas'), JSON.stringify(flatPaths.map(k => k.key)));
        }

        // `set:` name completion pulls the same chart defaults.
        const source = { uri: vscode.Uri.file(statePath), text, tree: parseTree(text) };
        const setOffset = text.indexOf('- name: ', text.indexOf('set:')) + '- name: '.length;
        const setList = contextualCompletions(source, setOffset, 'default');
        check('set name completes chart key paths', setList != null && setList.items.some(i => i.label === 'image.repository'), JSON.stringify(setList && setList.items.map(i => i.label)));
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
}


// ------------------------------------------------- completion replace ranges
// Accepting `.Values` after typing `.` must REPLACE the dot (default word
// definition treats `.` as a separator, so without an explicit range the
// insert appends and produces `..Values`).
{
    const { HelmfileCompletionProvider } = require('../src/completion') as typeof import('../src/completion');
    const mkDoc = (text: string) => ({
        uri: vscode.Uri.file('/tmp/helmfile-range-test.yaml.gotmpl'),
        getText: () => text,
        offsetAt: (pos: { line: number; character: number }) => {
            const lines = text.split('\n');
            let offset = 0;
            for (let i = 0; i < pos.line; i++) offset += (lines[i]?.length ?? 0) + 1;
            return offset + pos.character;
        },
    }) as never;
    const provider = new HelmfileCompletionProvider(() => 'default');
    const completions = (text: string, offset: number) => {
        const doc = mkDoc(text);
        const lines = text.split('\n');
        let line = 0, seen = 0;
        for (let i = 0; i < lines.length; i++) { seen += lines[i].length + 1; if (offset < seen) { line = i; break; } }
        const character = offset - (lines.slice(0, line).reduce((n, l) => n + l.length + 1, 0));
        return provider.provideCompletionItems(doc, new vscode.Position(line, character)) as vscode.CompletionList;
    };
    const rangeOf = (item: vscode.CompletionItem): { start: number; end: number } => {
        const range = item.range as { start: vscode.Position; end: vscode.Position };
        const lines = [];
        return { start: range.start.character, end: range.end.character };
    };

    // `{{ .` — the typed dot must be inside the replace range of `.Values`.
    const dotList = completions('a: {{ .', 7);
    const valuesItem = dotList.items.find(i => i.label === '.Values') as vscode.CompletionItem;
    check('context path item exists after bare dot', valuesItem != null, JSON.stringify(dotList.items.map(i => i.label).slice(0, 5)));
    if (valuesItem) {
        const r = rangeOf(valuesItem);
        check('dot included in replace range', r.start === 6 && r.end === 7, JSON.stringify(r));
    }

    // `{{ .Va` — range covers `.Va` entirely.
    const partial = completions('a: {{ .Va', 9);
    const vaItem = partial.items.find(i => i.label === '.Values') as vscode.CompletionItem;
    if (vaItem) {
        const r = rangeOf(vaItem);
        check('partial token covered', r.start === 6 && r.end === 9, JSON.stringify(r));
    }

    // Root block snippet: typing `rel` at the root replaces it and expands
    // into `releases:` + first item (no doubling of the typed word).
    const rootList = completions('rel', 3);
    const block = rootList.items.find(i => i.label === 'releases (block)') as vscode.CompletionItem;
    check('root block item offered', block != null, JSON.stringify(rootList.items.map(i => i.label).slice(0, 8)));
    if (block) {
        const r = rangeOf(block);
        const snippet = block.insertText as { value: string };
        check('root block replaces typed word', r.start === 0 && r.end === 3, JSON.stringify(r));
        check('root block expands section', snippet.value.startsWith('releases:\n  - name: '), snippet.value);
    }

    // Inside `releases:` typing `- rel` expands the alias into item fields.
    const listText = 'releases:\n  - rel';
    const listList = completions(listText, listText.length);
    const item2 = listList.items.find(i => i.label === 'release (block)') as vscode.CompletionItem;
    check('list block item offered', item2 != null, JSON.stringify(listList.items.map(i => i.label).slice(0, 8)));
    if (item2) {
        const snippet = item2.insertText as { value: string };
        check('list block expands item fields', snippet.value.startsWith('name: ') && snippet.value.includes('\n    chart: '), snippet.value);
    }

    // Field completions replace only the typed key letters.
    const fieldText = 'releases:\n  - name: a\n    nam';
    const fieldList = completions(fieldText, fieldText.length);
    const namespace = fieldList.items.find(i => i.label === 'namespace') as vscode.CompletionItem;
    if (namespace) {
        const r = rangeOf(namespace);
        check('field item covers typed word only', r.end - r.start === 3, JSON.stringify(r));
    }
}
// Chart template files: chart context detection, built-in variable
// completion/hover, values.yaml-backed `.Values` completion, and
// diagnostics that skip Helmfile state checks inside charts.
{
    const { chartRootOf, isChartTemplateFile, chartTemplateContextFor, chartTemplateDetected, chartValuePreview, CHART_BUILTINS } = require('../src/chartContext') as typeof import('../src/chartContext');
    const fs = require('node:fs');
    const os = require('node:os');
    const path = require('node:path');

    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'chartctx-'));
    fs.writeFileSync(path.join(root, 'Chart.yaml'), 'apiVersion: v2\nname: mychart\nversion: 0.1.0\n');
    fs.writeFileSync(path.join(root, 'values.yaml'), 'image:\n  repository: nginx\n  tag: latest\nreplicas: 3\n');
    fs.mkdirSync(path.join(root, 'templates'), { recursive: true });
    fs.mkdirSync(path.join(root, 'charts', 'subchart'), { recursive: true });
    const template = path.join(root, 'templates', 'deployment.yaml');
    fs.writeFileSync(template, 'apiVersion: apps/v1\n');
    fs.writeFileSync(path.join(root, 'values-no-chart.yaml'), 'a: 1\n');

    check('chartRootOf finds chart root', chartRootOf(template) === root, String(chartRootOf(template)));
    check('isChartTemplateFile accepts templates/', isChartTemplateFile(template), template);
    check('isChartTemplateFile rejects chart values.yaml', !isChartTemplateFile(path.join(root, 'values.yaml')));
    check('isChartTemplateFile rejects non-chart file', !isChartTemplateFile(path.join(os.tmpdir(), 'plain.yaml')));
    const ymlRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'chartctx-'));
    fs.mkdirSync(path.join(ymlRoot, 'templates'), { recursive: true });
    fs.writeFileSync(path.join(ymlRoot, 'Chart.yml'), 'name: y\n');
    check('Chart.yml also marks a chart', isChartTemplateFile(path.join(ymlRoot, 'templates', 'x.yaml')), ymlRoot);

    let stamp = 1;
    const nextStamp = () => ++stamp;
    const context = chartTemplateContextFor(template, nextStamp());
    check('chart context resolves', context != null);
    if (context) {
        check('chart name from Chart.yaml', context.name === 'mychart', context.name);
        check('chart values tree parsed', context.valuesTree != null);
        check('subchart listed', context.subcharts.includes('subchart'), JSON.stringify(context.subcharts));
        check('chartValuePreview resolves scalar', chartValuePreview(context, 'image.repository') === 'nginx', String(chartValuePreview(context, 'image.repository')));
        check('chartValuePreview handles missing key', chartValuePreview(context, 'nope.nope') === null);
        check('chartValuePreview handles missing single key', chartValuePreview(context, 'nope') === null, String(chartValuePreview(context, 'nope')));
        check('chart builtin catalog has Chart.Name', CHART_BUILTINS.some(b => b.path === 'Chart.Name'));
    }
    check('no context for state file outside chart', chartTemplateContextFor(path.join(os.tmpdir(), 'helmfile.yaml'), nextStamp()) === null);

    // Helmfile state files inside a chart keep their state treatment.
    const stateInChart = path.join(root, 'templates', 'helmfile.yaml');
    fs.writeFileSync(stateInChart, 'releases: []\n');
    check('isChartTemplateFile rejects state file inside chart', !isChartTemplateFile(stateInChart), stateInChart);
    check('no chart context for state file inside chart', chartTemplateContextFor(stateInChart, nextStamp()) === null, stateInChart);

    // Completion inside a chart template document.
    const { HelmfileCompletionProvider } = require('../src/completion') as typeof import('../src/completion');
    const mkChartDoc = (text: string) => ({
        uri: vscode.Uri.file(template),
        getText: () => text,
        offsetAt: (pos: { line: number; character: number }) => {
            const lines = text.split('\n');
            let offset = 0;
            for (let i = 0; i < pos.line; i++) offset += (lines[i]?.length ?? 0) + 1;
            return offset + pos.character;
        },
        positionAt: (offset: number) => {
            const lines = text.split('\n');
            let line = 0, seen = 0;
            for (let i = 0; i < lines.length; i++) { seen += lines[i].length + 1; if (offset < seen) { line = i; break; } }
            const character = offset - lines.slice(0, line).reduce((n, l) => n + l.length + 1, 0);
            return new vscode.Position(line, Math.max(0, character));
        },
    }) as never;
    const chartAt = (text: string, index: number) => {
        const doc = mkChartDoc(text);
        const lines = text.split('\n');
        let line = 0, seen = 0;
        for (let i = 0; i < lines.length; i++) { seen += lines[i].length + 1; if (index < seen) { line = i; break; } }
        const character = index - lines.slice(0, line).reduce((n, l) => n + l.length + 1, 0);
        return new HelmfileCompletionProvider(() => 'default').provideCompletionItems(doc, new vscode.Position(line, character)) as vscode.CompletionList;
    };

    const rootList = chartAt('{{ .', 4);
    const rootLabels = rootList.items.map(i => String(i.label));
    check('chart root paths offered', ['.Values', '.Chart', '.Release'].every(p => rootLabels.includes(p)), JSON.stringify(rootLabels.slice(0, 10)));
    check('no state paths in chart actions', !rootLabels.includes('.Environment.Name'), JSON.stringify(rootLabels.slice(0, 14)));

    const valuesList = chartAt('{{ .Values.', 11);
    const valuesLabels = valuesList.items.map(i => String(i.label));
    check('chart values keys from values.yaml', valuesLabels.includes('image') && valuesLabels.includes('replicas'), JSON.stringify(valuesLabels));
    const repository = valuesList.items.find(i => i.label === 'image');
    check('chart values detail mentions chart default', repository != null && String(repository.detail).includes('mychart'), repository ? String(repository.detail) : 'missing');

    const nestedList = chartAt('{{ .Values.image.', 17);
    const nestedLabels = nestedList.items.map(i => String(i.label));
    check('nested chart values keys', nestedLabels.includes('repository') && nestedLabels.includes('tag'), JSON.stringify(nestedLabels));

    const chartList = chartAt('{{ .Chart.', 10);
    const chartLabels = chartList.items.map(i => String(i.label));
    check('.Chart subpaths offered', chartLabels.includes('Name') && chartLabels.includes('AppVersion'), JSON.stringify(chartLabels.slice(0, 8)));
    const kubeList = chartAt('{{ .Capabilities.KubeVersion.', 29);
    check('.Capabilities nested subpaths', kubeList.items.some(i => i.label === 'Version'), JSON.stringify(kubeList.items.map(i => i.label)));
    const subchartList = chartAt('{{ .Subcharts.', 14);
    check('subchart names offered', subchartList.items.some(i => i.label === 'subchart'), JSON.stringify(subchartList.items.map(i => i.label)));

    // Review regressions: builtin completion must complete the NEXT path
    // segment, not the leaf of whatever entry happens to match.
    const capList = chartAt('{{ .Capabilities.', 17);
    const capLabels = capList.items.map(i => String(i.label));
    check('.Capabilities offers KubeVersion', capLabels.includes('KubeVersion'), JSON.stringify(capLabels));
    check('.Capabilities offers no leaf segments', !capLabels.includes('Version'), JSON.stringify(capLabels));
    const partialList = chartAt('{{ .Chart.Nam', 13);
    check('partial builtin completes without trailing dot', partialList.items.some(i => i.label === 'Name'), JSON.stringify(partialList.items.map(i => i.label)));
    const exactList = chartAt('{{ .Chart.Name', 14);
    check('fully typed builtin offers nothing new', exactList.items.length === 0 && !exactList.items.some(i => String(i.label) === ''), JSON.stringify(exactList.items.map(i => i.label)));
    const dollarList = chartAt('{{ $.Values.image.', 18);
    check('$ root context completes chart values', dollarList.items.some(i => i.label === 'repository'), JSON.stringify(dollarList.items.map(i => i.label)));

    const keyList = chartAt('rep', 3);
    check('no state field completion in chart templates', keyList.items.length === 0, JSON.stringify(keyList.items.map(i => i.label)));

    // Hover inside a chart template document.
    const { HelmfileHoverProvider } = require('../src/hover') as typeof import('../src/hover');
    const { EnvironmentService } = require('../src/settings') as typeof import('../src/settings');
    const env = new EnvironmentService({ workspaceState: { get: () => 'default', update: async () => undefined } } as never);
    const hoverAt = (text: string, index: number) => {
        const doc = mkChartDoc(text);
        const lines = text.split('\n');
        let line = 0, seen = 0;
        for (let i = 0; i < lines.length; i++) { seen += lines[i].length + 1; if (index < seen) { line = i; break; } }
        const character = index - lines.slice(0, line).reduce((n, l) => n + l.length + 1, 0);
        return new HelmfileHoverProvider(env).provideHover(doc, new vscode.Position(line, character)) as { contents: { value: string }[] } | null;
    };
    const hoverText = (hover: { contents: unknown } | null): string => {
        if (!hover) return 'null';
        const contents = Array.isArray(hover.contents) ? hover.contents : [hover.contents];
        return contents.map(c => (c && typeof c === 'object' && 'value' in c ? String((c as { value: string }).value) : String(c))).join('|');
    };
    const chartHover = hoverAt('{{ .Chart.Name }}', 8);
    check('.Chart.Name hover documents builtin', chartHover != null && hoverText(chartHover).includes('Name of the chart'), hoverText(chartHover));
    const valuesHover = hoverAt('{{ .Values.image.tag }}', 16);
    check('.Values hover shows chart default', valuesHover != null && hoverText(valuesHover).includes('latest'), hoverText(valuesHover));
    const functionHover = hoverAt('{{ toYaml .Values }}', 5);
    check('function hover still works in chart templates', functionHover != null && !hoverText(functionHover).includes('values.yaml'), hoverText(functionHover));

    // Diagnostics: chart templates skip state checks.
    const { HelmfileDiagnostics } = require('../src/inspection') as typeof import('../src/inspection');
    const diagnostics = new HelmfileDiagnostics(env);
    const captured: unknown[] = [];
    (diagnostics as unknown as { collection: { set: (uri: unknown, list: unknown[]) => void } }).collection = { set: (_uri, list) => captured.push(...list), delete: () => {}, clear: () => {}, dispose: () => {} };
    // State-only content that would flag missing files in a state file.
    const stateish = 'values:\n  - ./nope-missing.yaml\n';
    diagnostics.analyze({ uri: vscode.Uri.file(template), getText: () => stateish } as never);
    check('chart template skips state diagnostics', captured.length === 0, JSON.stringify(captured));
    captured.length = 0;
    const bad = '{{ .Values.x }\n';
    diagnostics.analyze({ uri: vscode.Uri.file(template), getText: () => bad } as never);
    check('chart template keeps template diagnostics', captured.length === 1, JSON.stringify(captured.map(d => (d as { message: string }).message)));

    // ---- Extended chart fixtures: subchart, schema, defines, list values. ----
    fs.writeFileSync(path.join(root, 'values.yaml'), 'image:\n  repository: nginx\n  tag: latest\nreplicas: 3\nlist:\n  - name: a\n    port: 1\n  - name: b\n    port: 2\n');
    fs.writeFileSync(path.join(root, 'values.schema.json'), JSON.stringify({
        properties: { image: { type: 'object', description: 'Container image of the app.' } },
    }));
    fs.writeFileSync(path.join(root, 'charts', 'subchart', 'Chart.yaml'), 'name: subchart\nversion: 0.1.0\n');
    fs.writeFileSync(path.join(root, 'charts', 'subchart', 'values.yaml'), 'port: 8080\n');
    const helpers = path.join(root, 'templates', '_helpers.tpl');
    fs.writeFileSync(helpers, '{{- define "mychart.name" -}}\n{{ .Chart.Name }}\n{{- end -}}\n{{- define "mychart.fullname" -}}\n{{ include "mychart.name" . }}-proxy\n{{- end -}}\n{{ define "unclosed.def" }}\nx');
    const overlay = fs.mkdtempSync(path.join(os.tmpdir(), 'chartmodel-'));
    fs.writeFileSync(path.join(overlay, 'helmfile.yaml'), [
        'releases:',
        '  - name: app',
        '    chart: ./charts/app',
        '    values:',
        '      - ./app-values.yaml',
        '      - port: 9090',
        '    set:',
        '      - name: replicas',
        '        value: 5',
    ].join('\n') + '\n');
    fs.writeFileSync(path.join(overlay, 'app-values.yaml'), 'image:\n  tag: overlay-tag\n');
    fs.mkdirSync(path.join(overlay, 'charts', 'app', 'templates'), { recursive: true });
    fs.writeFileSync(path.join(overlay, 'charts', 'app', 'Chart.yaml'), 'name: app\nversion: 0.1.0\n');
    fs.writeFileSync(path.join(overlay, 'charts', 'app', 'values.yaml'), 'image:\n  tag: default-tag\nreplicas: 1\nport: 80\n');
    fs.writeFileSync(path.join(overlay, 'charts', 'app', 'templates', 'dep.yaml'), 'apiVersion: apps/v1\n');
    const overlayTemplate = path.join(overlay, 'charts', 'app', 'templates', 'dep.yaml');

    // ---- chartModel: overlay precedence and sources. ----
    const { chartModelFor, subchartModel, iterationBaseModel } = require('../src/chartModel') as typeof import('../src/chartModel');
    const overlayContext = chartTemplateContextFor(overlayTemplate, nextStamp());
    check('overlay context resolves', overlayContext != null);
    if (overlayContext) {
        const model = chartModelFor(overlayContext, nextStamp(), 'default');
        const tag = model.valueAt(['image', 'tag']);
        check('overlay: values file overrides chart default', tag != null && tag.preview === 'overlay-tag', JSON.stringify(tag));
        check('overlay: values file is the source', tag != null && tag.source.includes('app-values.yaml'), tag ? tag.source : 'null');
        const port = model.valueAt(['port']);
        check('overlay: inline values apply', port != null && port.preview === '9090', JSON.stringify(port));
        const replicas = model.valueAt(['replicas']);
        check('overlay: set entry wins', replicas != null && replicas.preview === '5', JSON.stringify(replicas));
        check('overlay: set entry is the source', replicas != null && replicas.source === 'set: replicas', replicas ? replicas.source : 'null');
    }
    const freshContext = chartTemplateContextFor(template, nextStamp());
    check('fresh context for main chart', freshContext != null);
    if (freshContext) {
        const model = chartModelFor(freshContext, nextStamp(), 'default');
        const image = model.keysUnder([]).find(k => k.key === 'image');
        check('model: mapping key carries values.yaml source', image != null && image.source === 'mychart values.yaml', image ? image.source : 'null');
        check('model: preview of mapping is inline', image != null && image.preview === '{repository, tag}', image ? String(image.preview) : 'null');
        const sub = subchartModel(freshContext, 'subchart', nextStamp());
        check('model: subchart resolves its values', sub != null && sub.valueAt(['port'])?.preview === '8080', JSON.stringify(sub?.valueAt(['port'])));
        check('model: subchart missing chart is null', subchartModel(freshContext, 'nope', nextStamp()) === null);
        const base = iterationBaseModel('.Values.list', freshContext, nextStamp(), 'default');
        check('model: iteration base over chart values', base != null && base.segments.join('.') === 'list', base ? base.segments.join('.') : 'null');
        check('model: chart files exclude templates/', model.files.includes('values.yaml') && !model.files.includes('templates/deployment.yaml'), JSON.stringify(model.files));
        check('model: description from values.schema.json', model.schemaDescriptionAt(['image']) === 'Container image of the app.', String(model.schemaDescriptionAt(['image'])));
        const elementKeys = model.elementKeys(['list']).map(k => k.key);
        check('model: elementKeys of a list', elementKeys.includes('name') && elementKeys.includes('port'), JSON.stringify(elementKeys));
        check('model: iteration base rejects non-values path', iterationBaseModel('.Chart.Name', freshContext, nextStamp(), 'default') === null);
    }

    // ---- chartDefines: scanning and calls. ----
    const { scanDefines, chartDefinesFor, chartCallsFor, templateCallAt } = require('../src/chartDefines') as typeof import('../src/chartDefines');
    const scanned = scanDefines(fs.readFileSync(helpers, 'utf8'), helpers);
    check('defines: names scanned', scanned.map(d => d.name).includes('mychart.name') && scanned.map(d => d.name).includes('mychart.fullname'), JSON.stringify(scanned.map(d => d.name)));
    check('defines: unclosed define recorded to EOF', scanned.some(d => d.name === 'unclosed.def' && d.end === fs.readFileSync(helpers, 'utf8').length), JSON.stringify(scanned.map(d => [d.name, d.end])));
    check('defines: body captured', (scanned.find(d => d.name === 'mychart.name')?.body ?? '').includes('.Chart.Name'), scanned.find(d => d.name === 'mychart.name')?.body ?? '');
    if (freshContext) {
        const allDefines = chartDefinesFor(freshContext, nextStamp(), null);
        check('defines: cross-file collection includes helpers', allDefines.some(d => d.name === 'mychart.fullname'), JSON.stringify(allDefines.map(d => d.name)));
        const calls = chartCallsFor(freshContext, nextStamp(), null);
        check('defines: calls collected with file', calls.some(c => c.name === 'mychart.name' && c.file === helpers), JSON.stringify(calls));
        const callText = '{{ include "mychart.name" . }}';
        check('defines: templateCallAt finds name', templateCallAt(callText, 12)?.name === 'mychart.name', JSON.stringify(templateCallAt(callText, 12)));
        check('defines: templateCallAt outside name is null', templateCallAt(callText, 2) === null, JSON.stringify(templateCallAt(callText, 2)));
    }

    // ---- Completion: subcharts, files, defines, iteration, snippets. ----
    const subchartValuesList = chartAt('{{ .Subcharts.subchart.Values.', 30);
    check('.Subcharts.<name>.Values. completes subchart keys', subchartValuesList.items.some(i => i.label === 'port'), JSON.stringify(subchartValuesList.items.map(i => i.label)));
    const filesList = chartAt('{{ .Files.Get "', 15);
    const fileLabels = filesList.items.map(i => String(i.label));
    check('.Files.Get completes chart files', fileLabels.includes('values.yaml') && fileLabels.includes('Chart.yaml'), JSON.stringify(fileLabels));
    check('.Files.Get excludes templates/', !fileLabels.some(f => f.startsWith('templates/')), JSON.stringify(fileLabels));
    const defineList = chartAt('{{ include "', 12);
    const defineLabels = defineList.items.map(i => String(i.label));
    check('include completes define names', defineLabels.includes('mychart.name') && defineLabels.includes('mychart.fullname'), JSON.stringify(defineLabels));
    const includeDetail = defineList.items.find(i => i.label === 'mychart.name');
    check('include completion shows define body', includeDetail != null && String(includeDetail.detail).includes('_helpers.tpl'), includeDetail ? String(includeDetail.detail) : 'null');
    const rangeText = '{{ range .Values.list }}{{ .';
    const rangeList = chartAt(rangeText, rangeText.length);
    const rangeLabels = rangeList.items.map(i => String(i.label));
    check('range element keys complete relative paths', rangeLabels.includes('name') && rangeLabels.includes('port'), JSON.stringify(rangeLabels));
    check('range element completion skips state paths', !rangeLabels.includes('.Environment.Name'), JSON.stringify(rangeLabels));
    const withText = '{{ with .Values.image }}{{ .';
    const withList = chartAt(withText, withText.length);
    check('with scope completes map keys', withList.items.some(i => i.label === 'repository'), JSON.stringify(withList.items.map(i => i.label)));
    const snippetList = chartAt('{{ ran', 6);
    check('snippet skeleton offered', snippetList.items.some(i => i.kind === vscode.CompletionItemKind.Snippet && i.label === 'range'), JSON.stringify(snippetList.items.filter(i => i.kind === vscode.CompletionItemKind.Snippet).map(i => i.label)));

    // ---- Hover: defines, subchart values, iteration element, schema. ----
    const defineHover = hoverAt('{{ include "mychart.name" . }}', 12);
    check('include hover shows define body', defineHover != null && hoverText(defineHover).includes('named template') && hoverText(defineHover).includes('_helpers.tpl'), hoverText(defineHover));
    const subHover = hoverAt('{{ .Subcharts.subchart.Values.port }}', 31);
    check('subchart values hover resolves', subHover != null && hoverText(subHover).includes('8080'), hoverText(subHover));
    const rangeHoverText = '{{ range .Values.list }}{{ .port }}{{ end }}';
    const rangeHover = hoverAt(rangeHoverText, 29);
    check('range element field hover', rangeHover != null && hoverText(rangeHover).includes('`range` element') && hoverText(rangeHover).includes('name'), hoverText(rangeHover));
    const schemaHover = hoverAt('{{ .Values.image }}', 11);
    check('schema description in values hover', schemaHover != null && hoverText(schemaHover).includes('Container image of the app.'), hoverText(schemaHover));

    // ---- Navigation: definition and references. ----
    const { HelmfileDefinitionProvider, chartTemplateReferences } = require('../src/references') as typeof import('../src/references');
    const definition = new HelmfileDefinitionProvider(env).provideDefinition(mkChartDoc('{{ include "mychart.name" . }}') as never, new vscode.Position(0, 12)) as { uri: { fsPath: string } } | null;
    check('include jumps to define', definition != null && definition.uri.fsPath.endsWith('_helpers.tpl'), definition ? definition.uri.fsPath : 'null');
    if (freshContext) {
        const helperText = fs.readFileSync(helpers, 'utf8');
        const nameOffset = helperText.indexOf('"mychart.name"') + 1;
        const refs = chartTemplateReferences(helpers, helperText, nameOffset, freshContext);
        check('define references include declaration and calls', refs.length >= 2 && refs.some(r => r.uri.fsPath.endsWith('_helpers.tpl')), JSON.stringify(refs.map(r => r.uri.fsPath)));
        const overlayRefs = chartTemplateReferences(template, '{{ include "mychart.fullname" . }}', 12, freshContext);
        check('references on a call include other calls', overlayRefs.length === 2 && overlayRefs.some(r => r.uri.fsPath.endsWith('_helpers.tpl')) && overlayRefs.some(r => r.uri.fsPath.endsWith('deployment.yaml')), JSON.stringify(overlayRefs.map(r => r.uri.fsPath)));
    }

    // ---- Signature help. ----
    const { HelmfileSignatureHelpProvider } = require('../src/signatureHelp') as typeof import('../src/signatureHelp');
    const signature = new HelmfileSignatureHelpProvider();
    const sigDoc = (text: string, index: number) => {
        const doc = mkChartDoc(text);
        const lines = text.split('\n');
        let line = 0, seen = 0;
        for (let i = 0; i < lines.length; i++) { seen += lines[i].length + 1; if (index < seen) { line = i; break; } }
        const character = index - lines.slice(0, line).reduce((n, l) => n + l.length + 1, 0);
        return signature.provideSignatureHelp(doc, new vscode.Position(line, character)) as { signatures: { label: string; parameters: unknown[] }[]; activeParameter: number } | null;
    };
    const includeText = '{{ include "mychart.name" ';
    const includeSig = sigDoc(includeText, includeText.length);
    check('signature help for include', includeSig != null && includeSig.signatures.length > 0 && String(includeSig.signatures[0].label).startsWith('include('), includeSig ? String(includeSig.signatures[0]?.label) : 'null');
    const printfText = '{{ printf "%s-%s" "a" ';
    const printfSig = sigDoc(printfText, printfText.length);
    check('signature help counts parameters', printfSig != null && printfSig.activeParameter === 2, printfSig ? String(printfSig.activeParameter) : 'null');
    const noSig = sigDoc('{{ .Values.image ', 16);
    check('no signature help outside calls', noSig === null, JSON.stringify(noSig));

    // ---- Document symbols: define outline. ----
    const { HelmfileDocumentSymbolProvider } = require('../src/documentSymbol') as typeof import('../src/documentSymbol');
    const symbolsProvider = new HelmfileDocumentSymbolProvider();
    const helperSymbols = symbolsProvider.provideDocumentSymbols(mkChartDoc(fs.readFileSync(helpers, 'utf8')) as never) as { name: string; detail: string }[];
    check('outline shows defines', helperSymbols.some(s => s.name === 'mychart.name' && s.detail === 'define'), JSON.stringify(helperSymbols));

    // ---- Settings gate: helmfile.chartSupport=false. ----
    (vscode as unknown as { configOverrides: Record<string, unknown> }).configOverrides.chartSupport = false;
    const disabledRootList = chartAt('{{ .', 4);
    const disabledLabels = disabledRootList.items.map(i => String(i.label));
    check('chartSupport=false hides chart roots', !disabledLabels.includes('.Values'), JSON.stringify(disabledLabels));
    check('chartSupport=false hides state paths on chart files', !disabledLabels.includes('.Environment.Name'), JSON.stringify(disabledLabels));
    const disabledValuesList = chartAt('{{ .Values.image.', 18);
    check('chartSupport=false stops value completion', disabledValuesList.items.length === 0, JSON.stringify(disabledValuesList.items.map(i => i.label)));
    check('chartSupport=false keeps chart detection', chartTemplateDetected(template, nextStamp()), template);
    check('chartSupport=false disables chart context', chartTemplateContextFor(template, nextStamp()) === null, 'expected null');
    const disabledHover = hoverAt('{{ .Values.image.tag }}', 16);
    check('chartSupport=false keeps function hover only', disabledHover === null || !hoverText(disabledHover).includes('values.yaml'), hoverText(disabledHover));
    captured.length = 0;
    diagnostics.analyze({ uri: vscode.Uri.file(template), getText: () => stateish } as never);
    check('chartSupport=false still skips state diagnostics', captured.length === 0, JSON.stringify(captured));
    (vscode as unknown as { configOverrides: Record<string, unknown> }).configOverrides.chartSupport = true;
}
console.log(`\n${checks - failures}/${checks} checks passed`);
process.exit(failures === 0 ? 0 : 1);
