#!/bin/zsh
set -euo pipefail

project_dir="${0:A:h:h}"
output_png="${1:-$project_dir/desktop/AppIcon.png}"
module_cache="$project_dir/.build/swift-cache"
mkdir -p "${output_png:h}" "$module_cache"

xcrun swift -module-cache-path "$module_cache" "$project_dir/desktop/make-icon.swift" "$output_png"
print "已生成图标：$output_png"
