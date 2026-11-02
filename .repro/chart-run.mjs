import { runTests } from '@vscode/test-electron';
import * as fs from 'node:fs';

const localApp = '/Applications/Visual Studio Code.app/Contents/MacOS/Code';
const failed = await runTests({
    ...(fs.existsSync(localApp) ? { vscodeExecutablePath: localApp } : {}),
    extensionDevelopmentPath: process.cwd(),
    extensionTestsPath: process.cwd() + '/.repro/chart-suite.js',
    launchArgs: [
        '--user-data-dir=' + process.cwd() + '/.repro/user-data',
        process.env.CHART_WS,
    ],
});
if (failed) { console.error('FAILED', failed); process.exit(1); }
