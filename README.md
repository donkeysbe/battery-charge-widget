# GNOME Top Bar Widgets

Small GNOME Shell widgets for the top bar. Each one shows a live reading in the bar and opens a detailed popup, all in the same style.

| Widget | In the top bar | In the popup |
|---|---|---|
| [Battery Charge](docs/battery-charge.md) | Battery level and charge rate | Battery and charger readings, power graph, charge mode switch (Long Life, Standard, Fast) |
| [Network Monitor](docs/network-monitor.md) | Download and upload speed | Connection status, signal, traffic graph, IP and router details, latency, internet speed test (M-Lab), quick actions |
| [System Resources](docs/system-resources.md) | CPU load and temperature, memory and disk use | Per-thread load, CPU and memory graph, memory, swap, storage, disk activity, temperatures, GPUs, top processes, power mode switch |

<p>
  <img src="docs/battery-charge.png" alt="Battery Charge popup" width="340">
  <img src="docs/network-monitor.png" alt="Network Monitor popup" width="340">
  <img src="docs/system-resources.png" alt="System Resources popup" width="340">
</p>

Each widget is its own GNOME extension, so you can install any of them.

## Requirements

- GNOME Shell 48, 49 or 50.
- See each widget's page for what it needs from your hardware.

Developed and tested on Ubuntu 26.04 (GNOME 50, Wayland) with a Lenovo IdeaPad 5 Pro 16ACH6.

## Install

Download from the [latest release](https://github.com/donkeysbe/gnome-top-bar-widgets/releases/latest). Pick one way:

### Ubuntu and Debian: the .deb (all widgets)

Download `gnome-top-bar-widgets_<version>_all.deb` and open it to install it with App Center, or run:

```bash
sudo apt install ./gnome-top-bar-widgets_1.0.0_all.deb
```

This installs all three widgets for every user on the computer, plus the udev rule that lets Battery Charge switch charge modes without a password. Then:

1. Log out and back in: GNOME on Wayland only loads new extensions at login.
2. Turn on the widgets you want in the Extensions app.

To uninstall:

```bash
sudo apt remove gnome-top-bar-widgets
```

### Any distribution: one zip per widget

Download the `.shell-extension.zip` of each widget you want and run, for example:

```bash
gnome-extensions install network-monitor@donkeysbe.shell-extension.zip
```

Then log out and back in, and turn it on in the Extensions app. The zip installs for your user only. Battery Charge installed this way asks for your password each time you switch charge modes ([details](docs/battery-charge.md#switching-modes-without-a-password)).

To uninstall, remove it in the Extensions app.

### From source

```bash
git clone https://github.com/donkeysbe/gnome-top-bar-widgets.git
cd gnome-top-bar-widgets
./install.sh
```

That installs every widget for your user and turns them on. To install only some of them, name them:

```bash
./install.sh network
```

```bash
./install.sh battery system
```

Then log out and back in. Battery Charge also installs the udev rule; that step asks for your password.

To update, pull the latest version, run `./install.sh` again, then log out and back in. To uninstall:

```bash
gnome-extensions disable battery-charge@donkeysbe network-monitor@donkeysbe system-resources@donkeysbe
```

```bash
rm -r ~/.local/share/gnome-shell/extensions/{battery-charge,network-monitor,system-resources}@donkeysbe
```

```bash
sudo rm /etc/udev/rules.d/90-battery-charge-mode.rules
```

A copy installed from source or a zip (in your home folder) takes priority over the .deb's copy, so remove one before switching to the other.

## Turning a widget off

Use the Extensions app, or:

```bash
gnome-extensions disable network-monitor@donkeysbe
```

## Building the packages

```bash
./package.sh
```

This writes the .deb and the three zips to `dist/`. It needs only `dpkg-deb` and `zip`, and no root. The version comes from `VERSION`.

## Layout

```
battery-charge@donkeysbe/    Battery Charge extension
network-monitor@donkeysbe/   Network Monitor extension
system-resources@donkeysbe/  System Resources extension
udev/                        udev rule for Battery Charge
docs/                        a page and a screenshot per widget
install.sh                   installs all or some of the widgets from source
package.sh                   builds the .deb and the zips into dist/
VERSION                      the release version
```

To add a widget, give it its own `<name>@donkeysbe/` folder with a unique CSS class prefix (GNOME loads every extension's stylesheet globally), and add it to `UUIDS` and `ORDER` in `install.sh` and to `uuids` in `package.sh`.
