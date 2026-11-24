import { readdir, readFile, stat } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const docs = new URL('../../apps/docs/', import.meta.url)
const dist = fileURLToPath(new URL('dist/client/', docs))
const origin = 'https://flow.tagiadoc.workers.dev'
const urls = new Map()
const pages = new Map()
for (const relative of await readdir(dist, { recursive: true })) {
    if (!relative.endsWith('.html')) {
        continue
    }
    const html = await readFile(path.join(dist, relative), 'utf8')
    const url = '/' + relative.replace(/(^|\/)index\.html$/, '$1')
    const ids = new Set(Array.from(html.matchAll(/\sid="([^"]+)"/g), (match) => match[1]))
    urls.set(url.replace(/\/$/, '') || '/', ids)
    pages.set(url, html)
}

if (!urls.has('/')) {
    throw new Error('Astro の静的 HTML が見つかりません')
}
const broken = new Set()
for (const [url, html] of pages) {
    for (const [, raw] of html.matchAll(/<a(?=\s)[^>]*\shref="([^"]*)"[^>]*>/g)) {
        const destination = new URL(raw.replace(/&amp;/g, '&'), origin + url)
        if (destination.origin !== origin) {
            continue
        }
        const route = decodeURIComponent(destination.pathname).replace(/\/$/, '') || '/'
        const target =
            urls.get(route) ??
            (route.endsWith('/index.html') ? urls.get(route.replace(/\/index\.html$/, '') || '/') : undefined)
        const hash = decodeURIComponent(destination.hash.slice(1))
        if (target ? hash && !target.has(hash) : !(await stat(path.join(dist, route)).catch(() => null))?.isFile()) {
            broken.add(`${url} → ${raw}`)
        }
    }
}
if (broken.size) {
    throw new Error('内部リンクが存在しません:\n' + [...broken].join('\n'))
}
console.log(`${pages.size} ページの内部リンクと見出しを検証しました。`)
