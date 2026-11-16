#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
output="${1:-$root/dist/flow-universal.tar.gz}"
case "$output" in
  /*) ;;
  *) output="$PWD/$output" ;;
esac

if [[ ! -f "$root/dist/main.mjs" ]]; then
  echo "Run pnpm build first" >&2
  exit 1
fi

stage="$(mktemp -d)"
trap 'rm -rf "$stage"' EXIT
mkdir -p "$stage/bin" "$stage/lib" "$stage/templates" "$(dirname "$output")"
cp -R "$root/tools" "$root/skills" "$stage/"
cp "$root/dist/main.mjs" "$stage/lib/main.mjs"
cp "$root/LICENSE" "$stage/"
cp "$root/templates/WORKFLOW.md" "$root/templates/mise.toml" "$root/templates/gitignore" "$stage/templates/"
(cd "$root" && pnpm licenses list --prod --json | node scripts/release-licenses.mjs) > "$stage/THIRD_PARTY_LICENSES.txt"
cat > "$stage/bin/flow" <<'SCRIPT'
#!/usr/bin/env bash
set -euo pipefail
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
exec node "$root/lib/main.mjs" "$@"
SCRIPT
chmod 755 "$stage/bin/flow"
tar -czf "$output" -C "$stage" LICENSE bin lib skills templates tools THIRD_PARTY_LICENSES.txt
printf 'Created %s\n' "$output"
