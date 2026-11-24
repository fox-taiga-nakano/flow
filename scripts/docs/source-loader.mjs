// The CLI uses emitted .js specifiers. Resolve its TypeScript sources without running main.ts.
import { existsSync } from 'node:fs'
import { registerHooks } from 'node:module'
import { fileURLToPath } from 'node:url'

const source = new URL('../../src/', import.meta.url).href
registerHooks({
    resolve(specifier, context, next) {
        if (specifier.startsWith('.') && specifier.endsWith('.js') && context.parentURL?.startsWith(source)) {
            const candidate = new URL(specifier.replace(/\.js$/, '.ts'), context.parentURL)
            if (candidate.href.startsWith(source) && existsSync(fileURLToPath(candidate))) {
                return next(candidate.href, context)
            }
        }
        return next(specifier, context)
    },
})
