import stringWidth from 'string-width'

const box = /^[─│┌┬┐├┼┤└┴┘]+$/
const connections: Record<string, string> = {
    '─': 'lr',
    '│': 'tb',
    '┌': 'rb',
    '┬': 'lrb',
    '┐': 'lb',
    '├': 'rtb',
    '┼': 'lrtb',
    '┤': 'ltb',
    '└': 'rt',
    '┴': 'lrt',
    '┘': 'lt',
}

function drawBorder(part: string) {
    const horizontal: { start: number; end: number }[] = []
    const vertical: string[] = []
    for (let index = 0; index < part.length; index++) {
        const arms = connections[part[index]!]!
        const x = index * 10
        if (arms.includes('l') || arms.includes('r')) {
            const start = x + (arms.includes('l') ? 0 : 5)
            const end = x + (arms.includes('r') ? 10 : 5)
            const previous = horizontal.at(-1)
            if (previous?.end === start) {
                previous.end = end
            } else {
                horizontal.push({ start, end })
            }
        }
        if (arms.includes('t') || arms.includes('b')) {
            vertical.push(`M${x + 5} ${arms.includes('t') ? 0 : 5}V${arms.includes('b') ? 10 : 5}`)
        }
    }
    return horizontal.map(({ start, end }) => `M${start} 5H${end}`).join('') + vertical.join('')
}

// Match the CLI's glyph widths. Draw the borders separately from font glyphs.
export function terminalCells(text: string) {
    return text
        .split(/([─│┌┬┐├┼┤└┴┘]+|[^\p{ASCII}─│┌┬┐├┼┤└┴┘]+)/gu)
        .filter(Boolean)
        .map((part) => ({
            text: part,
            width: /\P{ASCII}/u.test(part) ? stringWidth(part) : 0,
            border: box.test(part) ? drawBorder(part) : undefined,
        }))
}
