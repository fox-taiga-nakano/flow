import { stripVTControlCharacters } from 'node:util'

/** Read only rendered text: envelope IDs/revisions are not agent output. */
export function terminalText(output: string): string {
    if (!output.trimStart().startsWith('{')) {
        return output
    }
    const data = JSON.parse(output)
    if (typeof data.result?.read?.text !== 'string') {
        throw new Error('herdr agent read の出力が不正です')
    }
    return data.result.read.text
}
const compact = (text: string) => text.replace(/\s+/gu, '')
const inputLine = /^\s*[❯›]\s?(.*)$/u
const border = /^\s*[─━]{3,}/u
const footer = /^\s*(?:\?\s|esc\b|enter\b|shift\+|ctrl\+|⏵)/iu

/** Conservative evidence: match the whole visible input, never a transcript substring. */
export function promptView(text: string, prompt: string): { pending: boolean; output: string } {
    const lines = stripVTControlCharacters(text).split(/\r?\n/u)
    const index = lines.findLastIndex((line) => inputLine.test(line))
    const input: string[] = []
    if (index >= 0) {
        input.push(inputLine.exec(lines[index]!)![1]!)
        for (const line of lines.slice(index + 1)) {
            if (border.test(line) || footer.test(line)) {
                break
            }
            input.push(line)
        }
    }
    // Only response blocks outside user input count as output evidence. Echoed or
    // folded pastes, prompt chrome and repaint/revision changes cannot acknowledge a turn.
    const response: string[] = []
    let assistant = false
    for (const line of index >= 0 ? lines.slice(0, index) : lines) {
        if (inputLine.test(line)) {
            assistant = false
        } else if (/^\s*[●•⏺]\s/u.test(line)) {
            assistant = true
        }
        if (assistant && !border.test(line) && !footer.test(line)) {
            response.push(line)
        }
    }
    return {
        pending: !!compact(prompt) && index >= 0 && compact(input.join('\n')) === compact(prompt),
        output: compact(response.join('\n')),
    }
}
