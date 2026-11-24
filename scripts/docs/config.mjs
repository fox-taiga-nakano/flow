import { readFileSync } from 'node:fs'
import ts from 'typescript'

const root = new URL('../../', import.meta.url)
const read = (file) => readFileSync(new URL(file, root), 'utf8')

export function configModel(workflow) {
    const source = ts.createSourceFile('types.ts', read('src/core/types.ts'), ts.ScriptTarget.Latest, true)
    const types = new Map(
        source.statements.filter(ts.isTypeAliasDeclaration).map((node) => [node.name.text, node.type])
    )
    const fields = []
    function visit(type, prefix = '', ancestorsRequired = true) {
        if (ts.isTypeLiteralNode(type)) {
            for (const property of type.members.filter(ts.isPropertySignature)) {
                const key = property.name.getText(source)
                if (key === 'prompts') {
                    continue
                } // Derived by parseWorkflow; not a YAML key.
                const path = prefix ? `${prefix}.${key}` : key
                const required = !property.questionToken
                fields.push({ path, type: summarize(property.type), required, ancestorsRequired })
                visit(property.type, path, ancestorsRequired && required)
            }
        } else if (ts.isTypeReferenceNode(type)) {
            const name = type.typeName.getText(source)
            if (name === 'Record') {
                visit(type.typeArguments[1], `${prefix}.*`, false)
            } else if (types.has(name)) {
                visit(types.get(name), prefix, ancestorsRequired)
            }
        } else if (ts.isUnionTypeNode(type)) {
            for (const member of type.types) {
                visit(member, prefix, false)
            }
        }
    }
    function summarize(type) {
        if (ts.isTypeLiteralNode(type)) {
            return 'オブジェクト'
        }
        if (ts.isUnionTypeNode(type)) {
            return type.types.map(summarize).join(' / ')
        }
        if (ts.isTypeReferenceNode(type)) {
            const name = type.typeName.getText(source)
            if (name === 'Record') {
                return `文字列 → ${summarize(type.typeArguments[1])}`
            }
            if (types.has(name)) {
                return summarize(types.get(name))
            }
        }
        return type.getText(source)
    }
    visit(types.get('Workflow'))
    const validator = read('src/core/workflow.ts')
    const ast = ts.createSourceFile('workflow.ts', validator, ts.ScriptTarget.Latest, true)
    const validation = []
    function collect(node) {
        if (ts.isCallExpression(node) && node.expression.getText(ast) === 'need') {
            validation.push(node.arguments.map((argument) => argument.getText(ast).replace(/\s+/g, ' ')))
        }
        ts.forEachChild(node, collect)
    }
    collect(ast)
    const shell = read('tools/lib/wt.sh')
    const jq = shell.match(/err="\$\(jq -e '\n([\s\S]+?)\n  ' --arg hooks/)
    if (!jq) {
        throw new Error('tools/lib/wt.sh: worktree 検証規則の抽出を更新してください')
    }
    const hooks = shell.match(/^WT_HOOKS="([^"]+)"/m)
    if (!hooks) {
        throw new Error('tools/lib/wt.sh: WT_HOOKS の抽出を更新してください')
    }
    return {
        fields,
        validation,
        worktreeValidation: jq[1].trim(),
        hooks: hooks[1].split(' '),
        worktreeExample: JSON.parse(read('templates/worktree.json')),
        workflowExample: Object.fromEntries(Object.entries(workflow).filter(([key]) => key !== 'prompts')),
        statuses: types.get('Status').types.map((type) => type.literal.text),
    }
}
