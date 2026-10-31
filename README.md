# Helmfile for Visual Studio Code

English | [简体中文](README.zh-CN.md)

Helmfile state file support for VSCode, ported from the
[helmfile-intellij-plugin](https://github.com/k3rnL/helmfile-intellij-plugin)
with feature parity.

## Installation

### From a prebuilt VSIX

Download the latest `vscode-helmfile-<version>.vsix` from
[Releases](https://github.com/helmfile/vscode-helmfile/releases), then:

```bash
code --install-extension vscode-helmfile-0.2.0.vsix --force
```

`--force` upgrades an already-installed older version. Reload the window
afterwards (**Developer: Reload Window**). On Remote-SSH / devcontainer
setups, use **Extensions: Install from VSIX…** on the remote side instead.

### Build from source

```bash
git clone https://github.com/helmfile/vscode-helmfile.git
cd vscode-helmfile
npm install
npm run package   # produces vscode-helmfile-<version>.vsix
code --install-extension vscode-helmfile-<version>.vsix --force
```

### Try without installing

Open the repository in VSCode and press **F5** — an Extension Development
Host launches with the sample state in `examples/`.

## Features

### Editing

- **Go template awareness** in `helmfile.yaml` / `helmfile.yml` /
  `*.gotmpl` / `_*.tpl`: custom grammar with functions, keywords, paths,
  strings and comments; typing `{{` auto-closes with `}}`.
- **Field completion** for every Helmfile mapping (`releases`,
  `repositories`, `environments`, `helmDefaults`, …) with types and
  descriptions.
- **Block completion**: type `releases`, `repositories` or `dependencies`
  (or `- release`, `- repository`, `- dependency`) and complete to a
  Tab-navigable snippet; the version placeholder defaults to the newest
  published version.
- **Repository completion**: `chart:` offers declared repository aliases,
  `repository/chart` offers chart names from the downloaded Helm index,
  `version:` offers the chart's versions (newest first). OCI registries use
  tag listings.
- **State values completion**: `.Values.`, `.StateValues.`,
  `.Environment.Values.` paths complete from the resolved values model
  (`values:` entries, `bases:` inheritance, environment overrides, glob
  paths, `{{ .Environment.Name }}` in paths).
- **Context-aware completion**: the editor knows what each field means —
  `needs:` offers the release names of this state, `inherit:` offers
  template declarations, `condition:` offers `<release>.enabled` and
  `.Values.<key>.enabled` flags, `kubeContext:` lists contexts from
  `$KUBECONFIG` / `~/.kube/config`, `values:` / `secrets:` / `bases:` /
  `helmfiles:` / `path:` offer files next to the state, `chart: ./…`
  offers local chart directories. Field completion hides keys already
  present in the mapping and ranks frequently-used fields first.
- **Chart-aware values completion**: keys in a release's values files
  (`values/*.yaml.gotmpl`) complete from the chart's own `values.yaml`
  defaults — local charts read from disk, remote charts from the download
  cache — and `set:` / `setString:` name entries offer dotted key paths
  (`image.tag`) with each key's chart default as the detail.
- **Environment variable completion**: inside `{{ env "…" }}` and
  `{{ requiredEnv "…" }}` quotes, variables come from the extension
  host environment and `.env` / `.env.local` files at the workspace root
  (project-local entries first, values shown in the detail).

### Navigation

- Go to definition / find usages for values paths, including
  `{{ index .Values "quoted.key" }}` forms.
- `repository/chart` prefix → repository declaration; repository name →
  chart usages.
- Chart name segment → **downloads the chart** (`helm pull`) and opens
  `Chart.yaml`; downloaded charts appear in the *Chart Sources* explorer
  view and are restored from cache on reload.
- `readFile` / values file / base file / nested state arguments open the
  target file.
- Template inheritance: `inherit: [{template: parent}]` ↔ template
  declarations (definition + usages).

### Documentation (hover)

- Go template / Sprig / Helmfile function documentation with signature,
  example and reference link.
- Values paths show the resolved value, its source file and environment —
  including quoted keys via `index .Values "a.b"` and `get` in both forms
  (`.Values | get "a.b" false` / `get .Values "a.b" false`).
- Inside any template action, other expressions (`if`/`range` conditions,
  `readFile … | fromYaml` chains, `get` defaults for keys no values file
  defines) show their statically computed value with its provenance.
- States with template-generated `environments:` entries (e.g. a `{{ range }}`
  over `readFile … | fromYaml`) resolve each environment's `values:` files
  after rendering the region, so values, completions and navigation work
  there too.

### VSCode integration

- **Semantic highlighting** for template actions: keywords, Go / Sprig /
  Helmfile functions, value paths, variables, strings, comments and
  numbers (on top of the TextMate grammar).
- **Outline & breadcrumbs**: releases, repositories, environments (with
  values files) and templates in the document symbol tree.
- **Folding** for YAML blocks and `---` documents.
- **Smart selection** (expand selection): identifier → dotted path →
  `{{ action }}` → YAML pair → mapping → document.
- **Quick fixes**: delete empty `{{}}` actions, close unclosed actions,
  remove orphan `}}`, refresh chart repositories from the warning.
- **Status bar** shows the active environment; click to switch.
- Diagnostics re-run debounced (150 ms) while typing.

### Environments

- Code lens on each `environments:` entry switches the active environment
  (check mark on the current one); also **Helmfile: Select Environment**.
  Selection is persisted **per helmfile project** and drives completion,
  navigation and chart version resolution.
- **Template-generated environments** are recognized statically — nothing is
  executed. States that generate entries with Go templates (the common
  workaround for [roboll/helmfile#1045](https://github.com/roboll/helmfile/issues/1045))
  resolve through two tiers:
  1. the pure read-only chain `readFile` → `fromYaml` → `index` over
     template variables — the keys of the resulting mapping become
     environment names (e.g. `bases/environments.yaml`);
  2. directory inference from value paths like
     `environments/{{ $key }}/*.yaml.gotmpl` — one environment per child
     directory.

  Inferred names appear in the environment switcher (a lens on the
  `environments:` key marks them *inferred*) and behave like literal ones
  everywhere else.

### Project detection

- Helmfile projects are recognized the way the `helmfile` CLI resolves
  them: `helmfile.yaml` → `helmfile.yaml.gotmpl` → `helmfile.d/*.{yaml,yml,
yaml.gotmpl,yml.gotmpl}` (sorted). Layouts the CLI would refuse to run
  (both `helmfile.yaml` and `helmfile.yaml.gotmpl`, or a default file next
  to `helmfile.d/`) are flagged with a warning.
- The extension activates automatically in workspaces containing a helmfile
  entry, even before any state file is opened.
- Run commands invoked outside a state file fall back to the governing
  project's entry (edit a values file, run **Helmfile: Template Release…**
  and it targets the state that would consume it).
- The status bar tooltip names the active project's entry state(s).

### Run

- Code lens on each release name: **Template / Diff / Apply / Destroy**.
- Editor context menu → *Helmfile Release Actions*; **Helmfile: Diff All
  Releases…** diffs the whole state.
- Dialog with environment picker, release/namespace inputs and a command
  preview; protected environments (regex, default `prod.*`) require
  explicit confirmation.
- **Template** renders into a read-only viewer: *All manifests.yaml* plus
  individual `<namespace>/<Kind>/<name>.yaml` resources.
- **Apply** reviews the diff first and continues through *Apply reviewed
  changes* (blocked if the state file changed meanwhile).
- **Diff** opens the native VSCode diff view per resource (added / modified
  / deleted).

### Validation

- Repository diagnostics: missing names/URLs, duplicate aliases, undeclared
  `chart:` prefixes, charts missing from the index, unavailable exact
  versions, and an outdated-version hint (with a one-click update to the
  newest cached version) when a pinned release version is behind the index.
- Unknown-field warnings for mappings the Helmfile schema fully describes
  (`releases`, `repositories`, `dependencies`, …) with a quick fix that
  removes the whole entry — catches typos like `insatlled:` before helmfile
  strict-decodes them at run time.
- Missing-file warnings when a `values:` / `secrets:` / `bases:` /
  `helmfiles:` entry points at a file that does not exist, with a quick fix
  that creates it (parent directories included).
- Unclosed / empty / orphan Go template delimiters and unmatched
  `if` / `range` / `with` / `define` / `block` blocks, plus YAML syntax
  errors — each with quick fixes.

### Chart repositories

- HTTP(S) repositories download `index.yaml` only; OCI repositories use
  paginated tag listings with bearer auth.
- Static credentials, `ALIAS_USERNAME` / `ALIAS_PASSWORD` environment
  credentials, `caFile`, `certFile`/`keyFile` (PKCS#8), `skipTLSVerify`,
  `passCredentials`.
- In-memory cache: successful snapshots refresh after 5 minutes, failures
  retry after 1 minute. **Helmfile: Refresh Chart Repositories** forces a
  reload. Downloads can be disabled in settings.

## Settings

| Setting | Default | Description |
| --- | --- | --- |
| `helmfile.helmfileExecutablePath` | `helmfile` | Path to the `helmfile` executable |
| `helmfile.helmExecutablePath` | `helm` | Path to `helm` (chart source browsing) |
| `helmfile.protectedEnvironments` | `prod.*` | Regex (full match) of protected environments |
| `helmfile.disableAutomaticDownloads` | `false` | Disable repository metadata downloads |
| `helmfile.enableMutatingCommands` | `false` | Enable the mutating commands (Apply/Destroy) and their code lenses; hidden and refused until enabled |

HTTP(S) access honors VSCode's `http.proxy` setting.

### Note for Go users

The [Go extension](https://marketplace.visualstudio.com/items?itemName=golang.go)
claims all `.gotmpl` files as pure Go templates. Canonical state files
(`helmfile.yaml.gotmpl`, `helmfile.yml.gotmpl`) are claimed by this extension
through exact filenames and are unaffected. If you use other `.gotmpl` file
names as Helmfile templates, associate them manually:

```json
"files.associations": { "**/my-helmfile.yaml.gotmpl": "helmfile" }
```

## Development

```bash
npm install
npm run compile   # tsc + esbuild
npm run package   # vsce package
```

Press F5 to launch an Extension Development Host with the sample state in
`examples/`.
