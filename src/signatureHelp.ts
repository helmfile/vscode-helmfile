/**
 * Signature help provider: converts the neutral signature computation into
 * vscode.SignatureHelp.
 */
import * as vscode from 'vscode';
import { signatureCallAt } from './signatureEngine';

export class HelmfileSignatureHelpProvider implements vscode.SignatureHelpProvider {
    provideSignatureHelp(document: vscode.TextDocument, position: vscode.Position): vscode.SignatureHelp | null {
        try {
            const call = signatureCallAt(document.getText(), document.offsetAt(position));
            if (!call) return null;
            const help = new vscode.SignatureHelp();
            const signature = new vscode.SignatureInformation(`${call.name}(${call.parameters.join(', ')})`);
            signature.documentation = call.documentation;
            for (const parameter of call.parameters) signature.parameters.push(new vscode.ParameterInformation(parameter));
            help.signatures.push(signature);
            help.activeSignature = 0;
            help.activeParameter = Math.min(call.args, Math.max(call.parameters.length - 1, 0));
            return help;
        } catch {
            return null;
        }
    }
}
