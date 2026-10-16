#!/bin/sh
# Stands in for npm, tsc, eslint and vitest in demo.tape: prints what the real tool would, slowly.
say() { for l in "$@"; do sleep 0.7; echo "$l"; done; }
case "$(basename "$0") $*" in
"npm ci") say "resolving 412 packages" "linking" "added 412 packages in 2.1s" ;;
"tsc -p tsconfig.build.json") say "emitting 38 files" "bundling" "dist/index.js 41 kB" ;;
"tsc --noEmit") say "checking 38 files" "found 0 errors" ;;
"eslint src") say "src/feed.ts:41:5  error  Unexpected console statement  no-console" "✖ 1 problem (1 error, 0 warnings)"; exit 1 ;;
"vitest run unit") say " ✓ parse > reads a feed" " ✓ merge > keeps order" " ✓ merge > dedupes" " Tests  48 passed" ;;
"vitest run e2e") say " ✓ publish > uploads" " ✓ publish > rewrites the feed" " Tests  12 passed" ;;
esac
