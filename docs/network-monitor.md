# Network Monitor

A top-bar widget that shows your download and upload speed live, plus everything about the connection you're on.

<img src="network-monitor.png" alt="The Network Monitor popup: connected to a Wi-Fi network, with a traffic graph, stat tiles and quick actions" width="420">

## What it shows

- **Top bar:** connection icon with the current download (↓) and upload (↑) speed. A VPN icon appears while a VPN is up. GNOME's own network icon is hidden while the widget is on (it comes back if you turn the widget off).
- **Status:** network name, whether you're Online, have No internet, need to sign in (captive portal) or are Connecting, and the Wi-Fi generation, band, channel and channel width.
- **Signal bar** for Wi-Fi strength.
- **Traffic graph** for the last 10 minutes: download in blue above the line, upload in purple below it. Each side has its own scale, so a small upload is still visible next to a big download.
- **Readings:** download and upload speed with their peaks, signal (dBm and quality), link speed, IP address, router with its ping, internet latency, data transferred, and DNS servers.
- **Quick actions:** turn Wi-Fi on or off, copy your IP address, and open the network settings. Hover a button to see what it does.

## Settings

At the top of `network-monitor@donkeysbe/extension.js`:

| Setting | Default | What it does |
|---|---|---|
| `SPEED_UNITS` | `'bytes'` | `'bytes'` shows kB/s and MB/s. `'bits'` shows kb/s and Mb/s, the way internet providers advertise speeds. |
| `LATENCY_HOST` | `'1.1.1.1'` | The address pinged for internet latency. |

Run `./install.sh network` again and log out and back in after changing them.

## Requirements

- NetworkManager (standard on Ubuntu, Fedora and most GNOME desktops).
- Optional: `iw`, for signal in dBm, both link speeds, channel width and Wi-Fi generation. Without it the widget falls back to `/proc/net/wireless` for the signal level and NetworkManager for the rest.

## How it works

- **Speed** comes from the byte counters in `/sys/class/net/*/statistics`, summed over the physical network interfaces (Wi-Fi, Ethernet, USB tethering). Bridges, Docker networks, VPN tunnels and loopback are left out, since their traffic already passes through a physical interface. The widget reads them every second while the popup is open and every 2 seconds otherwise.
- **Connection details** come from NetworkManager through libnm.
- **Latency:** while the popup is open, the widget pings the router and `LATENCY_HOST` every 3 seconds. Nothing is pinged while the popup is closed.
- **Transferred** is the total on the active interface since it came up, which is normally since boot.

To try the speed readings against recorded data instead of the real hardware, set `NMW_NET_DIR` to a folder laid out like `/sys/class/net`.
