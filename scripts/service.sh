#!/bin/zsh
set -eu
service_target="gui/$(id -u)/local.doubao-relay"
service_plist="$HOME/Library/LaunchAgents/local.doubao-relay.plist"
case "${1:-status}" in
 start) launchctl bootstrap "gui/$(id -u)" "$service_plist" ;;
 stop) launchctl bootout "$service_target" ;;
 restart)
   script_dir="${0:A:h}"
   node "$script_dir/service-restart.mjs"
   ;;
 status) launchctl print "$service_target" ;;
 *) echo "Usage: service.sh start|stop|restart|status"; exit 2 ;;
esac
