#!/usr/bin/env bash
# Installs the top-bar widgets for the current user.
#
#   ./install.sh                 install every widget
#   ./install.sh battery         only Battery Charge
#   ./install.sh network         only Network Monitor
#   ./install.sh system          only System Resources
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
ext_dir="$HOME/.local/share/gnome-shell/extensions"

declare -A UUIDS=(
  [battery]="battery-charge@donkeysbe"
  [network]="network-monitor@donkeysbe"
  [system]="system-resources@donkeysbe"
)
ORDER=(battery network system)

if [ $# -eq 0 ]; then
  selected=("${ORDER[@]}")
else
  selected=()
  for arg in "$@"; do
    if [ -z "${UUIDS[$arg]:-}" ]; then
      echo "Unknown widget '$arg'. Choose from: ${ORDER[*]}" >&2
      exit 1
    fi
    selected+=("$arg")
  done
fi

# Use a graphical password prompt when one is set up, plain sudo otherwise.
sudo_cmd() {
  [ -z "${SUDO_ASKPASS:-}" ] && [ -x "$HOME/.local/bin/askpass" ] && export SUDO_ASKPASS="$HOME/.local/bin/askpass"
  if [ -n "${SUDO_ASKPASS:-}" ]; then sudo -A "$@"; else sudo "$@"; fi
}

enable_extension() {
  local uuid="$1"
  if gnome-extensions enable "$uuid" 2>/dev/null; then
    return 0
  fi
  # GNOME on Wayland only discovers new extensions at login.
  local current
  current="$(gsettings get org.gnome.shell enabled-extensions)"
  if [[ "$current" != *"'$uuid'"* ]]; then
    if [[ "$current" == "@as []" || "$current" == "[]" ]]; then
      gsettings set org.gnome.shell enabled-extensions "['$uuid']"
    else
      gsettings set org.gnome.shell enabled-extensions "${current%]}, '$uuid']"
    fi
  fi
  need_relogin=1
}

battery_extras() {
  echo "  • Installing udev rule for charge modes (asks for your password)"
  sudo_cmd install -m 644 "$here/udev/90-battery-charge-mode.rules" /etc/udev/rules.d/90-battery-charge-mode.rules
  # Apply it now as well, without waiting for a reboot.
  for f in /sys/class/power_supply/*/charge_types; do
    [ -e "$f" ] || continue
    sudo_cmd chgrp sudo "$f"
    sudo_cmd chmod g+w "$f"
  done
}

need_relogin=0
mkdir -p "$ext_dir"
for name in "${selected[@]}"; do
  uuid="${UUIDS[$name]}"
  echo "• $uuid"
  echo "  • Copying to $ext_dir/$uuid"
  rm -rf "${ext_dir:?}/$uuid"
  cp -r "$here/$uuid" "$ext_dir/$uuid"
  if [ "$name" = battery ]; then battery_extras; fi
  echo "  • Enabling"
  enable_extension "$uuid"
done

if [ "$need_relogin" = 1 ]; then
  echo "Log out and back in to load the new widgets (needed once on Wayland)."
fi
echo "Done."
