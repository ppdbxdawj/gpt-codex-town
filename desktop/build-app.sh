#!/bin/zsh
set -euo pipefail

project_dir="${0:A:h:h}"
main_source="$project_dir/desktop/main.swift"
app_bundle="$project_dir/星糖庄园.app"
staging_dir="$(mktemp -d "$project_dir/.star-sugar-manor-build.XXXXXX")"
staging_bundle="$staging_dir/星糖庄园.app"
backup_bundle="$project_dir/.星糖庄园.previous.app"
contents_dir="$staging_bundle/Contents"
resources_dir="$contents_dir/Resources"
binary_path="$contents_dir/MacOS/StarSugarManor"
module_cache="$project_dir/.build/swift-cache"
trap 'rm -rf "$staging_dir"' EXIT

for required_file in \
  "$main_source" \
  "$project_dir/adapters.py" \
  "$project_dir/task_progress.py" \
  "$project_dir/cloud_catalog.py" \
  "$project_dir/schedule_results.py" \
  "$project_dir/desktop_service.py" \
  "$project_dir/review_store.py"; do
  [[ -f "$required_file" ]] || { print -u2 "缺少打包文件：$required_file"; exit 1; }
done
[[ -d "$project_dir/public" ]] || { print -u2 "缺少静态资源目录：$project_dir/public"; exit 1; }

(cd "$project_dir" && npm run prepare:vendor)

mkdir -p "$contents_dir/MacOS" "$resources_dir/service" "$module_cache"

cat > "$contents_dir/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleDevelopmentRegion</key>
  <string>zh-Hans</string>
  <key>CFBundleDisplayName</key>
  <string>星糖庄园</string>
  <key>CFBundleExecutable</key>
  <string>StarSugarManor</string>
  <key>CFBundleIdentifier</key>
  <string>com.local.starsugarmanor</string>
  <key>CFBundleInfoDictionaryVersion</key>
  <string>6.0</string>
  <key>CFBundleIconFile</key>
  <string>AppIcon.png</string>
  <key>CFBundleName</key>
  <string>星糖庄园</string>
  <key>CFBundlePackageType</key>
  <string>APPL</string>
  <key>CFBundleShortVersionString</key>
  <string>0.5.0</string>
  <key>CFBundleVersion</key>
  <string>0.5.0</string>
  <key>LSMinimumSystemVersion</key>
  <string>13.0</string>
  <key>LSUIElement</key>
  <false/>
  <key>NSHighResolutionCapable</key>
  <true/>
</dict>
</plist>
PLIST

"$project_dir/desktop/build-icon.sh" "$resources_dir/AppIcon.png"

xcrun swiftc \
  -swift-version 5 \
  -O \
  -target arm64-apple-macos13.0 \
  -framework Cocoa \
  -framework WebKit \
  -framework UserNotifications \
  -module-cache-path "$module_cache" \
  "$main_source" \
  -o "$binary_path"

ditto "$project_dir/public" "$resources_dir/public"
for service_file in adapters.py task_progress.py cloud_catalog.py schedule_results.py desktop_service.py review_store.py; do
  ditto "$project_dir/$service_file" "$resources_dir/service/$service_file"
done

codesign --force --deep --sign - "$staging_bundle"

rm -rf "$backup_bundle"
if [[ -d "$app_bundle" ]]; then
  mv "$app_bundle" "$backup_bundle"
fi
if ! mv "$staging_bundle" "$app_bundle"; then
  [[ -d "$backup_bundle" ]] && mv "$backup_bundle" "$app_bundle"
  print -u2 "无法替换星糖庄园.app。"
  exit 1
fi
rm -rf "$backup_bundle"
print "已构建：$app_bundle"
