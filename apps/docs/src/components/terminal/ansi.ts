// Convert the SGR attributes emitted by Output into text and fixed CSS classes.
// Terminal links and other control sequences are discarded. Astro escapes every text segment.
const attributes: Record<number, string> = {
    1: 'bold',
    2: 'dim',
    4: 'underline',
    31: 'red',
    32: 'green',
    33: 'yellow',
    34: 'blue',
    90: 'gray',
}
const colors = [31, 32, 33, 34, 90]
export function ansiSpans(input: string) {
    // Match OSC, CSI and other terminal controls. Only CSI ending in m is interpreted.
    // eslint-disable-next-line no-control-regex -- terminal escape sequences start with ESC
    const controls = /\x1b(?:\][^\x07\x1b]*(?:\x07|\x1b\\)|\[[0-?]*[ -/]*[@-~]|[@-_])/g
    const output: { text: string; classes: string[] }[] = []
    const active = new Set<number>()
    let cursor = 0
    function append(text: string) {
        if (text) {
            output.push({ text, classes: [...active].map((code) => 'ansi-' + attributes[code]) })
        }
    }
    for (const match of input.matchAll(controls)) {
        append(input.slice(cursor, match.index))
        const sequence = match[0]
        cursor = match.index + sequence.length
        if (!sequence.startsWith('\x1b[') || !sequence.endsWith('m')) {
            continue
        }
        for (const code of sequence.slice(2, -1).split(';').map(Number)) {
            if (code === 0) {
                active.clear()
            }
            if (code === 22) {
                active.delete(1)
                active.delete(2)
            }
            if (code === 24) {
                active.delete(4)
            }
            if (code === 39 || colors.includes(code)) {
                colors.forEach((color) => active.delete(color))
            }
            if (Object.hasOwn(attributes, code)) {
                active.add(code)
            }
        }
    }
    append(input.slice(cursor))
    return output
}
