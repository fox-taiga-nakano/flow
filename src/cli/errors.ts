import type { Command, CommanderError } from 'commander'

function flag(flags: string): string {
    const names = flags.split(/[ ,|]+/)
    return names.find((name) => name.startsWith('--')) ?? names[0]!
}
function reason(message: string): string {
    const choices = /^Allowed choices are ([\s\S]*)\.$/.exec(message)
    return choices ? `選べる値: ${choices[1]}` : message
}

// Commander 15 exposes code and message, but not structured argument/option fields.
// Decode its pinned message formats here; argv and parsed option values are never reparsed.
export function errorMessage(error: CommanderError, command: Command): string {
    const message = error.message
    switch (error.code) {
        case 'commander.invalidArgument': {
            const option = /^error: option '([^']+)' argument '([\s\S]*)' is invalid\. ([\s\S]*)$/.exec(message)
            if (option) {
                return `${flag(option[1]!)} の値が不正です: ${option[2] || '""'}（${reason(option[3]!)}）`
            }
            const argument =
                /^error: command-argument value '([\s\S]*)' is invalid for argument '([^']+)'\. ([\s\S]*)$/.exec(
                    message
                )
            if (argument) {
                const name = argument[2]!
                const declared = command.registeredArguments.find((arg) => arg.name() === name)
                const label = declared?.required ? `<${name}>` : `[${name}]`
                return `${label} の値が不正です: ${argument[1] || '""'}（${reason(argument[3]!)}）`
            }
            break
        }
        case 'commander.unknownOption': {
            const match = /^error: unknown option '([\s\S]*?)'(?:\n\(Did you mean (?:one of )?([^\n]*)\?\))?$/.exec(
                message
            )
            if (match) {
                return `使えないオプションです: ${match[1]}${match[2] ? `\n候補: ${match[2]}` : ''}`
            }
            break
        }
        case 'commander.unknownCommand': {
            const match = /^error: unknown command '([\s\S]*?)'(?:\n\(Did you mean (?:one of )?([^\n]*)\?\))?$/.exec(
                message
            )
            if (match) {
                return `知らないコマンドです: ${match[1]}${match[2] ? `\n候補: ${match[2]}` : ''}`
            }
            break
        }
        case 'commander.missingArgument': {
            const match = /^error: missing required argument '([^']+)'$/.exec(message)
            if (match) {
                return `引数が足りません: <${match[1]}>`
            }
            break
        }
        case 'commander.optionMissingArgument': {
            const match = /^error: option '([^']+)' argument missing$/.exec(message)
            if (match) {
                return `オプションの値がありません: ${match[1]}`
            }
            break
        }
        case 'commander.missingMandatoryOptionValue': {
            const match = /^error: required option '([^']+)' not specified$/.exec(message)
            if (match) {
                return `必須のオプションがありません: ${match[1]}`
            }
            break
        }
        case 'commander.conflictingOption': {
            const match = /^error: option '([^']+)' cannot be used with option '([^']+)'$/.exec(message)
            if (match) {
                return `${flag(match[1]!)} と ${flag(match[2]!)} は同時に使えません`
            }
            break
        }
        case 'commander.excessArguments': {
            const match = /Expected (\d+) arguments? but got (\d+): ([\s\S]*)\.$/.exec(message)
            if (match) {
                return `引数が多すぎます: ${match[3]}（指定できる数: ${match[1]}、受け取った数: ${match[2]}）`
            }
            break
        }
        case 'commander.help':
            // Native helpCommand reports an unknown help target as commander.help.
            return command.args[0] === 'help' && command.args[1]
                ? `知らないコマンドです: ${command.args[1]}`
                : 'コマンドを指定してください'
    }
    // Application-generated Command.error messages are already Japanese.
    if (!message.startsWith('error:') && /[ぁ-んァ-ヶ一-龠]/.test(message)) {
        return message
    }
    return `入力の指定が不正です（${error.code}）`
}
