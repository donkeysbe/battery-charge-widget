#!/usr/bin/env bash
# Installs the Battery Charge GNOME Shell extension for the current user,
# plus a udev rule so charge modes can be switched without a password.
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
uuid="battery-charge@donkeysbe"
dest="$HOME/.local/share/gnome-shell/extensions/$uuid"

echo "• Installing extension to $dest"
mkdir -p "$(dirname "$dest")"
rm -rf "$dest"
cp -r "$here/$uuid" "$dest"

echo "• Installing udev rule (asks for your password)"
# Use a graphical password prompt when one is set up, plain sudo otherwise.
[ -z "${SUDO_ASKPASS:-}" ] && [ -x "$HOME/.local/bin/askpass" ] && export SUDO_ASKPASS="$HOME/.local/bin/askpass"
if [ -n "${SUDO_ASKPASS:-}" ]; then SUDO=(sudo -A); else SUDO=(sudo); fi
"${SUDO[@]}" install -m 644 "$here/90-battery-charge-mode.rules" /etc/udev/rules.d/90-battery-charge-mode.rules
# Apply it now as well, without waiting for a reboot.
for f in /sys/class/power_supply/*/charge_types; do
  [ -e "$f" ] || continue
  "${SUDO[@]}" chgrp sudo "$f"
  "${SUDO[@]}" chmod g+w "$f"
done

echo "• Enabling extension"
if ! gnome-extensions enable "$uuid" 2>/dev/null; then
  # GNOME on Wayland only discovers new extensions at login.
  current="$(gsettings get org.gnome.shell enabled-extensions)"
  if [[ "$current" != *"'$uuid'"* ]]; then
    if [[ "$current" == "@as []" || "$current" == "[]" ]]; then
      gsettings set org.gnome.shell enabled-extensions "['$uuid']"
    else
      gsettings set org.gnome.shell enabled-extensions "${current%]}, '$uuid']"
    fi
  fi
  echo "  Log out and back in to load it (needed once on Wayland)."
fi
echo "Done."
