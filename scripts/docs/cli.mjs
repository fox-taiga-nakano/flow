import { createProgram } from '../../src/cli/commands.ts'
import { Output } from '../../src/cli/output.ts'

const silent = () => {}
export function commands() {
    const program = createProgram({ output: silent, error: silent, view: new Output({ isTTY: false, env: {} }) })
    const collect = (command, parents = []) => {
        const names = [...parents, command.name()]
        const help = command.createHelp()
        const hasHelp = help.visibleCommands(command).some((child) => child.name() === 'help')
        return [
            {
                id: names.slice(1).join('/') || 'flow',
                name: names.join(' '),
                aliases: command.aliases(),
                summary: command.description(),
                syntax: `${names.join(' ')} ${command.usage()}`.trim(),
                args: command.registeredArguments.map((argument) => ({
                    name: argument.name(),
                    description: argument.description,
                    required: argument.required,
                    variadic: argument.variadic,
                    default: argument.defaultValue,
                    choices: argument.argChoices,
                })),
                options: help.visibleOptions(command).map((option) => ({
                    id: option.long ?? option.short,
                    flags: option.flags,
                    description: option.description,
                    kind: option.required || option.optional ? 'value' : 'flag',
                    required: option.mandatory,
                    default: option.defaultValue,
                    choices: option.argChoices,
                    conflicts: option.conflictsWith,
                })),
                help: command.helpInformation(),
            },
            ...command.commands.flatMap((child) => collect(child, names)),
            ...(!hasHelp
                ? []
                : [
                      {
                          id: [...names.slice(1), 'help'].join('/'),
                          name: [...names, 'help'].join(' '),
                          aliases: [],
                          summary: 'コマンドの使い方を表示',
                          syntax: `${names.join(' ')} help [command]`,
                          args: [{ name: 'command', required: false, description: '表示対象のサブコマンド' }],
                          options: [],
                      },
                  ]),
        ]
    }
    return collect(program)
}
