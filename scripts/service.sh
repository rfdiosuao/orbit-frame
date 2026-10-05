#!/bin/zsh
set -eu
service_target="gui/$(id -u)/local.doubao-relay"
service_plist="$HOME/Library/LaunchAgents/local.doubao-relay.plist"
case "${1:-status}" in
 start) launchctl bootstrap "gui/$(id -u)" "$service_plist" ;;
 stop) launchctl bootout "$service_target" ;;
 restart) launchctl kickstart -k "$service_target" ;;
 status) launchctl print "$service_target" ;;
 *) echo "Usage: service.sh start|stop|restart|status"; exit 2 ;;
esac
