/**
 * Functional tests for the extension's core modules, driven by the same
 * example helmfile state the IntelliJ plugin ships. Runs under plain Node
 * with the vscode mock — no extension host, no cluster, no apply/sync.
 */
import * as path from 'node:path';
import * as fs from 'node:fs';
import * as vscode from 'vscode';
import { TemplateScanner } from '../src/templateScanner';
import { templateBlocks, unclosedActions, fillMaskedTemplateKeys } from '../src/inspection';
import { allFunctions, findFunction } from '../src/functionCatalog';
import { readSource, stateFor, valuesModel, allDefinitions, childKeys, resolveValueFiles, SEPARATOR, bumpContentVersion } from '../src/values';
import { repositoryModel, query, alias } from '../src/repositories';
import { ChartIndex, compareVersions } from '../src/chartIndex';
import { parseTemplateOutput, parseDiffOutput, diffPartial } from '../src/outputs';
import { commandProblem, buildCommand, protectionProblem, isProtectedEnvironment, selectorOf } from '../src/execution';
import { valuePathAt } from '../src/references';
import { schemaContext } from '../src/schema';
import { parseCompletionPath } from '../src/yamlTree';
import { tokenizeAction, SEMANTIC_TOKEN_TYPES } from '../src/semanticTokens';
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

console.log(`\n${checks - failures}/${checks} checks passed`);
process.exit(failures === 0 ? 0 : 1);
