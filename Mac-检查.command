#!/bin/zsh
set -eu
entry_dir="${0:A:h}"
exec /bin/zsh "$entry_dir/deployment/mac-runner.sh" doctor
