#!/bin/zsh
set -u

script_dir="${0:A:h}"
binary_path="$script_dir/星糖庄园.app/Contents/MacOS/StarSugarManor"

[[ -x "$binary_path" ]] || { echo "找不到星糖庄园应用可执行文件。"; exit 1; }

matched=0
for process_id in ${(f)"$(pgrep -f "$binary_path" 2>/dev/null || true)"}; do
  command_line="$(ps -p "$process_id" -o command= 2>/dev/null || true)"
  if [[ "$command_line" == "$binary_path"* ]]; then
    kill -TERM "$process_id"
    matched=1
  fi
done

if [[ "$matched" == 1 ]]; then
  echo "已请求星糖庄园退出。"
else
  echo "未找到正在运行的星糖庄园应用。"
fi
