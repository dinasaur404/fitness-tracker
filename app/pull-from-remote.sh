#!/bin/bash
# Pull changes from OpenCode Remote
# Usage: ./pull-from-remote.sh

API="https://opencode-remote.dinas.workers.dev"
PROJECT="fitness-tracker"

echo "🔄 Pulling changes from OpenCode Remote..."
echo ""

# Get list of files and download each one
curl -s "$API/files?prefix=projects/$PROJECT/" | \
  jq -r '.files[].key' | while read file; do
    # Remove the projects/PROJECT/ prefix to get local path
    local_path="${file#projects/$PROJECT/}"
    
    # Create directory if needed
    mkdir -p "$(dirname "$local_path")"
    
    # Download file content
    echo "  ↓ $local_path"
    curl -s "$API/files/$file" | jq -r '.content' > "$local_path"
done

echo ""
echo "✅ Pull complete!"
