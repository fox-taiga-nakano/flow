export const normalizeAuthor = (name: string): string =>
    name
        .toLowerCase()
        .replace(/^app\//, '')
        .replace(/\[bot\]$/, '')
