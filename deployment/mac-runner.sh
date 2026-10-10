#!/bin/zsh
# Finder entry point; the Node program contains all deployment logic.
set -eu
umask 077
deployment_dir="${0:A:h}"
project_dir="${deployment_dir:h}"
export PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"
cd "$project_dir"

finish() {
  deployment_result=$?
  trap - EXIT
  if [ "$deployment_result" -ne 0 ]; then
    print '\n操作未完成，请按上方提示处理后再运行。'
  fi
  if [ -t 0 ] && [ "${ORBIT_FRAME_NO_PAUSE:-0}" != "1" ]; then
    printf '\n按回车关闭此窗口…'
    read -r deployment_reply || true
  fi
  exit "$deployment_result"
}
trap finish EXIT

if ! command -v node >/dev/null 2>&1; then
  print '请先从 https://nodejs.org/en/download 安装 Node.js 24 LTS 的 macOS 安装包，再重新运行。'
  exit 1
fi
node "$deployment_dir/mac-deploy.mjs" "$@"
