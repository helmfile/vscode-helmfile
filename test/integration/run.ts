/**
 * Host-side driver: launches the user's real VSCode with the extension loaded
 * from the repository and runs test/integration/suite.ts inside it.
 */
import { runTests } from '@vscode/test-electron';

async function main(): Promise<void> {
    const electronPath = '/Applications/Visual Studio Code.app/Contents/MacOS/Code';
    const failed = await runTests({
        vscodeExecutablePath: electronPath,
        extensionDevelopmentPath: __dirname + '/../..',
        extensionTestsPath: __dirname + '/suite.js',
        launchArgs: [
            '--disable-extensions',
            '--user-data-dir=' + __dirname + '/../../.test-user-data',
            '--extensionDevelopmentPath=' + __dirname + '/../..',
            process.env.CI_EXAMPLES_DIR ?? __dirname + '/../../examples',
        ],
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
