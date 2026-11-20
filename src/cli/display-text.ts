import path from 'node:path'
import stringWidth from 'string-width'

const graphemes = new Intl.Segmenter('ja', { granularity: 'grapheme' })
const segments = (text: string) => Array.from(graphemes.segment(text), (part) => part.segment)

export function elapsedTime(seconds: number): string {
    if (!Number.isFinite(seconds)) {
        return '-'
    }
    const value = Math.max(0, Math.floor(seconds))
    if (value < 60) {
        return `${value}秒`
    }
    if (value < 3600) {
        return `${Math.floor(value / 60)}分`
    }
    if (value < 86400) {
        return `${Math.floor(value / 3600)}時間${Math.floor((value % 3600) / 60) ? `${Math.floor((value % 3600) / 60)}分` : ''}`
    }
    return `${Math.floor(value / 86400)}日${Math.floor((value % 86400) / 3600) ? `${Math.floor((value % 86400) / 3600)}時間` : ''}`
}

/** Lossless prose wrapping: ASCII identifiers are whole tokens, Japanese uses graphemes. */
export function wrapText(text: string, columns: number, indent = ''): string {
    const width = Math.max(2, Math.floor(columns) - stringWidth(indent))
    const lines: string[] = []
    for (const input of text.split('\n')) {
        const tokens: string[] = []
        let word = ''
        for (const char of segments(input)) {
            if (/^[A-Za-z0-9_]+$/.test(char)) {
                word += char
            } else {
                if (word) {
                    tokens.push(word)
                }
                word = ''
                tokens.push(char)
            }
        }
        if (word) {
            tokens.push(word)
        }
        let line = '',
            used = 0
        const flush = () => {
            lines.push(indent + line)
            line = ''
            used = 0
        }
        for (const token of tokens) {
            const size = stringWidth(token)
            if (size <= width) {
                if (used + size > width && line) {
                    flush()
                }
                line += token
                used += size
            } else {
                // Only a token wider than an entire line may be split internally.
                for (const char of segments(token)) {
                    const charSize = stringWidth(char)
                    if (used + charSize > width && line) {
                        flush()
                    }
                    line += char
                    used += charSize
                }
            }
        }
        lines.push(indent + line)
    }
    return lines.join('\n')
}

/** Keep the tail and file extension, preferring whole path components when they fit. */
export function pathTail(text: string, columns: number): string {
    if (stringWidth(text) <= columns) {
        return text
    }
    const parts = text.split(/[\\/]/)
    for (let index = 1; index < parts.length; index++) {
        const tail = '…/' + parts.slice(index).join('/')
        if (stringWidth(tail) <= columns) {
            return tail
        }
    }
    let tail = ''
    for (const char of segments(parts.at(-1) ?? text).reverse()) {
        if (stringWidth('…' + char + tail) > columns) {
            break
        }
        tail = char + tail
    }
    return '…' + tail
}
const escapeRegex = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
export type IssueLocation = { dir: string; issue: number; pattern?: string }

/** Render paths under the current or a former stage directory relative to that Issue. */
export function relativeArtifacts(text: string, location?: IssueLocation): string {
    if (!location) {
        return text
    }
    const { dir, issue, pattern } = location
    const root = path.dirname(dir)
    const current = path.basename(dir)
    const stage = pattern ? new RegExp(pattern) : undefined
    const prefix = new RegExp(`(^|[\\s"'(:=,])${escapeRegex(root)}/([^/\\r\\n]+)(/|(?=$|[\\s"'),]))`, 'g')
    return text.replace(prefix, (all, before: string, name: string, slash: string) => {
        if (name !== current && !(stage?.test(name) && name.endsWith(`_${issue}`))) {
            return all
        }
        return before + (slash ? '' : '.')
    })
}
