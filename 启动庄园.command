#!/bin/zsh
set -u

script_dir="${0:A:h}"
app_bundle="$script_dir/星糖庄园.app"

if [[ ! -d "$app_bundle" ]]; then
  echo "找不到星糖庄园.app。请先运行 desktop/build-app.sh 打包应用。"
  exit 1
fi

open "$app_bundle"
