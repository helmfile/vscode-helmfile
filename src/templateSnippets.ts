/**
 * Skeleton snippets for the common Go-template constructs, offered by the
 * completion fallback while typing an action. Bodies assume the opening
 * `{{ ` has already been typed: the first line closes the action, the rest
 * reopens it for `{{- end }}`.
 */
export interface TemplateSnippet {
    readonly trigger: string;
    readonly detail: string;
    /** VSCode snippet text (without the leading `{{ `). */
    readonly body: string;
}

export const TEMPLATE_SNIPPETS: readonly TemplateSnippet[] = [
    {
        trigger: 'range',
        detail: 'range over a list or map',
        body: 'range ${1:.Values.list} }}\n  ${2:{{ .name }}}\n{{- end }}',
    },
    {
        trigger: 'with',
        detail: 'narrow the scope to a value',
        body: 'with ${1:.Values.context} }}\n  ${2:{{ .field }}}\n{{- end }}',
    },
    {
        trigger: 'if',
        detail: 'conditional block',
        body: 'if ${1:.Values.enabled} }}\n  ${2:{{ . | toYaml }}}\n{{- end }}',
    },
    {
        trigger: 'ifelse',
        detail: 'conditional block with fallback',
        body: 'if ${1:.Values.enabled} }}\n  ${2}\n{{- else }}\n  ${3}\n{{- end }}',
    },
    {
        trigger: 'include',
        detail: 'render a named template',
        body: 'include "${1:name}" ${2:.}}',
    },
    {
        trigger: 'define',
        detail: 'declare a named template',
        body: 'define "${1:name}" }}\n  ${2}\n{{- end }}',
    },
    {
        trigger: 'block',
        detail: 'declare a template with default body',
        body: 'block "${1:name}" ${2:.} }}\n  ${3}\n{{- end }}',
    },
];

/** Snippets whose trigger starts with the partially typed word. */
export function snippetsFor(typed: string): readonly TemplateSnippet[] {
    if (!typed) return [];
    return TEMPLATE_SNIPPETS.filter(snippet => snippet.trigger.startsWith(typed));
}
