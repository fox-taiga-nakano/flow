import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'

const licenses = JSON.parse(readFileSync(0, 'utf8'))
const sections = []
for (const packages of Object.values(licenses)) {
    for (const pkg of packages) {
        for (const packagePath of pkg.paths) {
            const file = readdirSync(packagePath).find((name) => /^licen[sc]e(?:[-.].*)?$/i.test(name))
            if (!file) {
                throw new Error(`License file missing for ${pkg.name} at ${packagePath}`)
            }
            const version = JSON.parse(readFileSync(path.join(packagePath, 'package.json'), 'utf8')).version
            sections.push(
                `${pkg.name}@${version}\n${'='.repeat(60)}\n${readFileSync(path.join(packagePath, file), 'utf8').trim()}\n`
            )
        }
    }
}
process.stdout.write(sections.sort().join('\n'))
