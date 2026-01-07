#!/bin/bash
# Sync fitness-tracker to OpenCode Remote
# Usage: ./sync-to-remote.sh

API="https://opencode-remote.dinas.workers.dev"
PROJECT="fitness-tracker"

echo "🔄 Syncing $PROJECT to OpenCode Remote..."
echo ""

# Find all source files (excluding node_modules, dist, .wrangler, etc.)
count=0
find . -type f \
  ! -path "./node_modules/*" \
  ! -path "./dist/*" \
  ! -path "./.wrangler/*" \
  ! -path "./.git/*" \
  ! -name "*.lock" \
  ! -name "package-lock.json" \
  ! -name ".DS_Store" \
  | while read file; do
    # Remove leading ./
    filepath="${file#./}"
    echo "  ↑ $filepath"
    curl -s -X PUT "$API/files/projects/$PROJECT/$filepath" \
      --data-binary @"$file" > /dev/null
done

echo ""
echo "✅ Sync complete!"
echo "📱 Open on your phone: $API"
