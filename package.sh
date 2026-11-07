#!/usr/bin/env bash
# Builds installable files into dist/:
#
#   gnome-top-bar-widgets_<version>_all.deb    all widgets + the battery udev rule
#                                              (Ubuntu, Debian and derivatives)
#   <uuid>.shell-extension.zip                 one per widget, for any distribution:
#                                              gnome-extensions install <file>
#
# Needs only dpkg-deb and zip; no root.
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
cd "$here"
version="$(tr -d '[:space:]' < VERSION)"
name="gnome-top-bar-widgets"
uuids=(battery-charge@donkeysbe network-monitor@donkeysbe system-resources@donkeysbe)
dist="$here/dist"

rm -rf "$dist"
mkdir -p "$dist"

# ---------- one zip per extension ----------
for uuid in "${uuids[@]}"; do
  (cd "$uuid" && zip -qr -X -D "$dist/$uuid.shell-extension.zip" . -x '*.directory' -x '.*')
  echo "• dist/$uuid.shell-extension.zip"
done

# ---------- the .deb ----------
root="$dist/build/${name}_${version}_all"
mkdir -p "$root/DEBIAN" \
         "$root/usr/share/gnome-shell/extensions" \
         "$root/usr/lib/udev/rules.d" \
         "$root/usr/share/doc/$name"

for uuid in "${uuids[@]}"; do
  cp -r "$uuid" "$root/usr/share/gnome-shell/extensions/"
done
install -m 644 udev/90-battery-charge-mode.rules "$root/usr/lib/udev/rules.d/"
install -m 644 README.md "$root/usr/share/doc/$name/README.md"
mkdir -p "$root/usr/share/doc/$name/docs" && cp docs/*.md "$root/usr/share/doc/$name/docs/"
cat > "$root/usr/share/doc/$name/copyright" <<EOF
Format: https://www.debian.org/doc/packaging-manuals/copyright-format/1.0/
Upstream-Name: $name
Source: https://github.com/donkeysbe/$name

Files: *
Copyright: 2026 Dimi <dimi@donkeys.be>
EOF
find "$root" -name '.directory' -delete
find "$root" -type d -exec chmod 755 {} +
find "$root" -type f -exec chmod 644 {} +

installed_kb="$(du -sk --exclude=DEBIAN "$root" | cut -f1)"
cat > "$root/DEBIAN/control" <<EOF
Package: $name
Version: $version
Architecture: all
Maintainer: Dimi <dimi@donkeys.be>
Installed-Size: $installed_kb
Depends: gnome-shell (>= 48)
Recommends: power-profiles-daemon, iw
Section: gnome
Priority: optional
Homepage: https://github.com/donkeysbe/$name
Description: GNOME Shell top-bar widgets: battery, network and system resources
 Three GNOME Shell extensions that each show a live reading in the top bar
 and open a detailed popup:
 .
  * Battery Charge: battery and charger readings, power graph and a switch
    for the charge mode (Long Life, Standard, Fast) on laptops that support it.
  * Network Monitor: live download and upload speed, connection details,
    signal, latency, a traffic graph and an internet speed test (M-Lab).
  * System Resources: CPU load and temperature, memory, storage, disk
    activity, temperatures, GPUs, top processes and the power mode.
 .
 After installing, log out and back in, then turn the widgets on in the
 Extensions app.
EOF

cat > "$root/DEBIAN/postinst" <<'EOF'
#!/bin/sh
set -e
if [ "$1" = "configure" ]; then
  # Apply the charge-mode udev rule now, without waiting for a reboot.
  if command -v udevadm >/dev/null 2>&1; then
    udevadm control --reload-rules 2>/dev/null || true
    udevadm trigger --subsystem-match=power_supply --action=add 2>/dev/null || true
  fi
  echo "Top bar widgets installed. Log out and back in, then turn them on in the"
  echo "Extensions app, or run:"
  echo "  gnome-extensions enable battery-charge@donkeysbe"
  echo "  gnome-extensions enable network-monitor@donkeysbe"
  echo "  gnome-extensions enable system-resources@donkeysbe"
fi
exit 0
EOF

cat > "$root/DEBIAN/postrm" <<'EOF'
#!/bin/sh
set -e
if [ "$1" = "remove" ] || [ "$1" = "purge" ]; then
  if command -v udevadm >/dev/null 2>&1; then
    udevadm control --reload-rules 2>/dev/null || true
  fi
fi
exit 0
EOF
chmod 755 "$root/DEBIAN/postinst" "$root/DEBIAN/postrm"

dpkg-deb --root-owner-group -Zxz --build "$root" "$dist/${name}_${version}_all.deb" >/dev/null
rm -rf "$dist/build"
echo "• dist/${name}_${version}_all.deb"
