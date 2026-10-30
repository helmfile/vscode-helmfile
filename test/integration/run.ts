/**
 * Host-side driver: launches VSCode with the extension loaded from the
 * repository and runs test/integration/suite.ts inside it.
 *
 * Locally this prefers the installed VSCode app; in CI (no local app, e.g.
 * ubuntu-latest) @vscode/test-electron downloads a VSCode build instead.
 */
import { runTests } from '@vscode/test-electron';
import * as fs from 'node:fs';

async function main(): Promise<void> {
    const localApp = '/Applications/Visual Studio Code.app/Contents/MacOS/Code';
    const useLocalApp = fs.existsSync(localApp);

    const launchArgs = [
        '--disable-extensions',
        '--user-data-dir=' + __dirname + '/../../.test-user-data',
        '--extensionDevelopmentPath=' + __dirname + '/../..',
        process.env.CI_EXAMPLES_DIR ?? __dirname + '/../../examples',
    ];
    // Containers (GitLab docker, some CI sandboxes) run Electron as root and
    // need the Chromium sandbox disabled; harmless elsewhere.
    if (process.env.CI) launchArgs.push('--no-sandbox');

    const failed = await runTests({
        ...(useLocalApp ? { vscodeExecutablePath: localApp } : {}),
        extensionDevelopmentPath: __dirname + '/../..',
        extensionTestsPath: __dirname + '/suite.js',
        launchArgs,
    });
    if (failed) {
        console.error('integration tests FAILED');
        process.exit(1);
    }
}

void main().catch(error => {
    console.error(error);
    process.exit(1);
});
