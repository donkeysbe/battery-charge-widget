// Network Monitor: a top-bar widget with live download/upload speed and
// connection details (NetworkManager + /sys/class/net), in the same style
// as Battery Charge.

import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import GObject from 'gi://GObject';
import St from 'gi://St';
import Clutter from 'gi://Clutter';
import Pango from 'gi://Pango';
import NM from 'gi://NM';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import * as Util from 'resource:///org/gnome/shell/misc/util.js';

import {runSpeedTest} from './speedtest.js';

Gio._promisify(Gio.File.prototype, 'load_contents_async');
Gio._promisify(Gio.Subprocess.prototype, 'communicate_utf8_async');
Gio._promisify(NM.Client, 'new_async');

// Overridable so the speed readings can be tried against recorded data.
const NET = GLib.getenv('NMW_NET_DIR') || '/sys/class/net';
// 'bytes' shows kB/s and MB/s; 'bits' shows kb/s and Mb/s like an ISP would.
const SPEED_UNITS = 'bytes';
// Pinged for the internet latency tile, only while the popup is open.
const LATENCY_HOST = '1.1.1.1';
const HISTORY_SECONDS = 600;
const REFRESH_OPEN = 1;
const REFRESH_CLOSED = 2;
const PING_EVERY = 3;
const CONTENT_WIDTH = 340;

const DOWN_RGB = [0.21, 0.52, 0.89]; // #3584e4
const UP_RGB = [0.75, 0.38, 0.80];   // #c061cb

let iconDir = null; // set on enable: the extension's icons/ folder

function localIcon(name) {
    const file = iconDir?.get_child(`${name}.svg`);
    if (file?.query_exists(null))
        return Gio.FileIcon.new(file);
    return Gio.ThemedIcon.new(name);
}

// The last speed test result, kept across logins.
const SPEEDTEST_FILE = GLib.build_filenamev([GLib.get_user_cache_dir(), 'network-monitor', 'speedtest.json']);

function loadSpeedTest() {
    try {
        const [, bytes] = GLib.file_get_contents(SPEEDTEST_FILE);
        const r = JSON.parse(new TextDecoder().decode(bytes));
        return typeof r.download === 'number' ? r : null;
    } catch {
        return null;
    }
}

function saveSpeedTest(r) {
    try {
        GLib.mkdir_with_parents(GLib.path_get_dirname(SPEEDTEST_FILE), 0o755);
        GLib.file_set_contents(SPEEDTEST_FILE, JSON.stringify(r));
    } catch (e) {
        logError(e, 'network-monitor');
    }
}

const PHYSICAL_TYPES = new Set([
    NM.DeviceType.WIFI, NM.DeviceType.ETHERNET, NM.DeviceType.MODEM, NM.DeviceType.BT,
]);

// ---------- reading ----------

async function readText(path) {
    try {
        const [bytes] = await Gio.File.new_for_path(path).load_contents_async(null);
        return new TextDecoder().decode(bytes).trim();
    } catch {
        return null;
    }
}

function listDir(path) {
    const names = [];
    try {
        const dir = GLib.Dir.open(path, 0);
        let n;
        while ((n = dir.read_name()) !== null)
            names.push(n);
        dir.close();
    } catch {}
    return names;
}

// Byte counters of the real network hardware (Wi-Fi, Ethernet, USB
// tethering...). Bridges, Docker, VPN tunnels and loopback are left out:
// their traffic already passes through a physical interface.
async function readTraffic(primaryIface) {
    const names = listDir(NET).filter(n =>
        n !== 'lo' && GLib.file_test(`${NET}/${n}/device`, GLib.FileTest.EXISTS));
    const per = await Promise.all(names.map(async n => {
        const [rx, tx] = await Promise.all([
            readText(`${NET}/${n}/statistics/rx_bytes`),
            readText(`${NET}/${n}/statistics/tx_bytes`),
        ]);
        return {name: n, rx: Number(rx ?? 0), tx: Number(tx ?? 0)};
    }));
    return {
        key: names.sort().join(','),
        rx: per.reduce((s, p) => s + p.rx, 0),
        tx: per.reduce((s, p) => s + p.tx, 0),
        primary: per.find(p => p.name === primaryIface) ?? null,
    };
}

async function runOut(argv) {
    try {
        const proc = Gio.Subprocess.new(argv,
            Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_SILENCE);
        const [stdout] = await proc.communicate_utf8_async(null, null);
        return proc.get_successful() ? stdout : null;
    } catch {
        return null;
    }
}

async function ping(host) {
    if (!host)
        return null;
    const out = await runOut(['ping', '-n', '-c', '1', '-W', '1', host]);
    const m = out && /time[=<]([\d.]+)\s*ms/.exec(out);
    return m ? Number(m[1]) : null;
}

const IW = GLib.find_program_in_path('iw');

// Radio details NetworkManager doesn't give: signal in dBm, both bitrates,
// channel width and Wi-Fi generation. `iw` is optional; without it the
// signal level still comes from /proc/net/wireless.
async function readRadio(iface) {
    const r = {dbm: null, rx: null, tx: null, width: null, gen: null};
    const out = IW ? await runOut([IW, 'dev', iface, 'link']) : null;
    if (out) {
        const sig = /signal:\s*(-?\d+)/.exec(out);
        const rx = /rx bitrate:\s*([\d.]+) MBit\/s(.*)/.exec(out);
        const tx = /tx bitrate:\s*([\d.]+) MBit\/s(.*)/.exec(out);
        r.dbm = sig ? Number(sig[1]) : null;
        r.rx = rx ? Number(rx[1]) : null;
        r.tx = tx ? Number(tx[1]) : null;
        const extra = `${rx?.[2] ?? ''} ${tx?.[2] ?? ''}`;
        const w = /(\d+)MHz/.exec(extra);
        r.width = w ? Number(w[1]) : null;
        r.gen = /EHT-/.test(extra) ? 7 : /HE-/.test(extra) ? 6 : /VHT-/.test(extra) ? 5 : /MCS/.test(extra) ? 4 : null;
    }
    if (r.dbm === null) {
        const text = await readText('/proc/net/wireless');
        const line = text?.split('\n').find(l => l.trim().startsWith(`${iface}:`));
        const level = line ? parseFloat(line.split(/\s+/).filter(Boolean)[3]) : NaN;
        if (!Number.isNaN(level) && level < 0)
            r.dbm = Math.round(level);
    }
    return r;
}

function isVpn(ac) {
    const t = ac.get_connection_type();
    return ac.get_vpn() || t === 'wireguard' || t === 'vpn';
}

function firstAddress(cfg, skipLinkLocal = false) {
    const list = cfg?.get_addresses() ?? [];
    const a = list.find(x => !skipLinkLocal || !x.get_address().toLowerCase().startsWith('fe80'));
    return a ? {address: a.get_address(), prefix: a.get_prefix()} : null;
}

// Everything NetworkManager knows about the connection in use, read from
// libnm's cache (no D-Bus round trips).
function readConnection(client) {
    if (!client?.get_nm_running())
        return {state: 'no-nm', hasWifi: false};

    const devices = client.get_devices() ?? [];
    const hasWifi = devices.some(d => d.get_device_type() === NM.DeviceType.WIFI);
    const wifiEnabled = client.wireless_enabled;
    const active = client.get_active_connections() ?? [];
    const physical = active.filter(ac => !isVpn(ac) &&
        PHYSICAL_TYPES.has(ac.get_devices()?.[0]?.get_device_type()));
    const ac = physical.find(a => a.get_default() || a.get_default6()) ??
        physical.find(a => a.get_state() === NM.ActiveConnectionState.ACTIVATED) ??
        physical[0] ?? null;
    const vpns = active.filter(isVpn).map(a => a.get_id());

    const c = {hasWifi, wifiEnabled, vpns, kind: null, name: null, iface: null, hw: null};
    if (!ac) {
        c.state = client.get_activating_connection() ? 'connecting'
            : hasWifi && !wifiEnabled ? 'wifi-off' : 'offline';
        return c;
    }

    const dev = ac.get_devices()[0];
    c.iface = dev.get_ip_iface() || dev.get_iface();
    c.hw = dev.get_hw_address();
    c.name = ac.get_id();
    switch (dev.get_device_type()) {
    case NM.DeviceType.WIFI: {
        c.kind = 'wifi';
        const ap = dev.get_active_access_point();
        if (ap) {
            const ssid = ap.get_ssid();
            c.name = (ssid && NM.utils_ssid_to_utf8(ssid.get_data())) || c.name;
            c.wifi = {
                strength: ap.get_strength(),
                freq: ap.get_frequency(),
                bitrate: dev.get_bitrate() / 1000, // Mb/s
                width: ap.get_bandwidth?.() || null,
                secure: ap.get_rsn_flags() !== 0 || ap.get_wpa_flags() !== 0 ||
                    (ap.get_flags() & NM['80211ApFlags'].PRIVACY) !== 0,
            };
        }
        break;
    }
    case NM.DeviceType.ETHERNET:
        c.kind = 'ethernet';
        c.ethSpeed = dev.get_speed?.() || null;
        break;
    case NM.DeviceType.MODEM:
        c.kind = 'modem';
        break;
    default:
        c.kind = 'other';
    }

    const ip4 = ac.get_ip4_config();
    const ip6 = ac.get_ip6_config();
    c.ip4 = firstAddress(ip4);
    c.ip6 = firstAddress(ip6, true);
    c.gateway = ip4?.get_gateway() || ip6?.get_gateway() || null;
    c.dns = [...(ip4?.get_nameservers() ?? []), ...(ip6?.get_nameservers() ?? [])];

    if (ac.get_state() !== NM.ActiveConnectionState.ACTIVATED) {
        c.state = 'connecting';
    } else {
        switch (client.get_connectivity()) {
        case NM.ConnectivityState.FULL: c.state = 'online'; break;
        case NM.ConnectivityState.PORTAL: c.state = 'portal'; break;
        case NM.ConnectivityState.LIMITED:
        case NM.ConnectivityState.NONE: c.state = 'limited'; break;
        default: c.state = 'connected'; // connectivity checking is off
        }
    }
    return c;
}

// ---------- formatting ----------

function fmtRate(bytesPerSec, compact = false) {
    const bits = SPEED_UNITS === 'bits';
    let v = Math.max(0, bytesPerSec) * (bits ? 8 : 1);
    const units = bits ? ['b/s', 'kb/s', 'Mb/s', 'Gb/s'] : ['B/s', 'kB/s', 'MB/s', 'GB/s'];
    let i = 0;
    // The top bar never goes below kB/s, so its width stays steady.
    while ((v >= 999.5 || (compact && i === 0)) && i < units.length - 1) {
        v /= 1000;
        i++;
    }
    const s = i === 0 || v >= 100 ? Math.round(v) : v < 0.05 ? 0 : v.toFixed(1);
    return `${s} ${units[i]}`;
}

function fmtMbps(v) {
    return v >= 1000 ? `${(v / 1000).toFixed(v % 1000 ? 1 : 0)} Gb/s` : `${Math.round(v)} Mb/s`;
}

// Speed test results are always in bits, like every speed test site.
function fmtTest(mbit) {
    if (mbit >= 1000)
        return `${(mbit / 1000).toFixed(2)} Gb/s`;
    return `${mbit < 10 ? mbit.toFixed(1) : Math.round(mbit)} Mb/s`;
}

function fmtMs(v) {
    return `${v < 10 ? v.toFixed(1) : Math.round(v)} ms`;
}

function fmtWhen(unix) {
    const t = GLib.DateTime.new_from_unix_local(unix);
    const today = GLib.DateTime.new_now_local();
    const sameDay = t.get_year() === today.get_year() && t.get_day_of_year() === today.get_day_of_year();
    return t.format(sameDay ? 'today %H:%M' : '%-d %b %H:%M');
}

function band(freq) {
    if (!freq)
        return null;
    if (freq < 3000)
        return {name: '2.4 GHz', ch: freq === 2484 ? 14 : (freq - 2407) / 5};
    if (freq < 5925)
        return {name: '5 GHz', ch: (freq - 5000) / 5};
    return {name: '6 GHz', ch: (freq - 5950) / 5};
}

function signalIcon(strength) {
    return strength < 20 ? 'none' : strength < 40 ? 'weak' : strength < 50 ? 'ok' : strength < 80 ? 'good' : 'excellent';
}

function signalWord(dbm, strength) {
    if (dbm !== null && dbm !== undefined)
        return dbm >= -55 ? 'Excellent' : dbm >= -65 ? 'Good' : dbm >= -72 ? 'Fair' : 'Weak';
    return strength >= 80 ? 'Excellent' : strength >= 55 ? 'Good' : strength >= 35 ? 'Fair' : 'Weak';
}

// What the connection is doing, in words: [title, pill, dot class, subtitle].
function describe(c, radio) {
    switch (c.state) {
    case 'no-nm':
        return ['Network', 'Unavailable', 'offline', 'NetworkManager isn\'t running'];
    case 'wifi-off':
        return ['Wi-Fi off', 'Offline', 'offline', 'Wi-Fi is turned off'];
    case 'offline':
        return ['Offline', 'Offline', 'offline', c.hasWifi ? 'Not connected to a network' : 'No cable connected'];
    }
    const pill = {
        online: ['Online', 'online'],
        connected: ['Connected', 'online'],
        portal: ['Sign-in needed', 'limited'],
        limited: ['No internet', 'limited'],
        connecting: ['Connecting', 'connecting'],
    }[c.state] ?? ['Connected', 'online'];

    const parts = [];
    if (c.kind === 'wifi') {
        const gen = radio?.gen;
        const b = band(c.wifi?.freq);
        parts.push(gen ? `Wi-Fi ${gen}${gen === 6 && b?.name === '6 GHz' ? 'E' : ''}` : 'Wi-Fi');
        if (b)
            parts.push(b.name, `channel ${b.ch}`);
        const width = radio?.width ?? c.wifi?.width;
        if (width)
            parts.push(`${width} MHz`);
        if (c.wifi && !c.wifi.secure)
            parts.push('open network');
    } else if (c.kind === 'ethernet') {
        parts.push('Ethernet');
        if (c.ethSpeed)
            parts.push(fmtMbps(c.ethSpeed));
    } else if (c.kind === 'modem') {
        parts.push('Mobile broadband');
    }
    if (c.vpns.length)
        parts.push(`VPN ${c.vpns.join(', ')}`);
    return [c.name ?? (c.state === 'connecting' ? 'Connecting…' : 'Connected'), ...pill, parts.join(' · ')];
}

function panelIcon(c) {
    const prefix = c.kind === 'ethernet' ? 'network-wired' : 'network-wireless';
    switch (c.state) {
    case 'no-nm':
        return 'network-error-symbolic';
    case 'wifi-off':
        return 'network-wireless-disabled-symbolic';
    case 'offline':
        return c.hasWifi ? 'network-wireless-offline-symbolic' : 'network-wired-disconnected-symbolic';
    case 'connecting':
        return `${prefix}-acquiring-symbolic`;
    case 'portal':
    case 'limited':
        return `${prefix}-no-route-symbolic`;
    }
    if (c.kind === 'wifi')
        return `network-wireless-signal-${signalIcon(c.wifi?.strength ?? 0)}-symbolic`;
    if (c.kind === 'modem')
        return 'network-cellular-connected-symbolic';
    return 'network-wired-symbolic';
}

// ---------- UI ----------

function label(text, styleClass, params = {}) {
    return new St.Label({text, style_class: styleClass, ...params});
}

const NetworkIndicator = GObject.registerClass(
class NetworkIndicator extends PanelMenu.Button {
    _init() {
        super._init(0.5, 'Network Monitor', false);
        this._history = [];
        this._sample = null;
        this._latency = null;
        this._lastPing = 0;
        this._actions = {};

        // Top bar
        const box = new St.BoxLayout({style_class: 'panel-status-menu-box'});
        this._panelIcon = new St.Icon({icon_name: 'network-wireless-acquiring-symbolic', style_class: 'system-status-icon'});
        this._panelVpn = new St.Icon({
            icon_name: 'network-vpn-symbolic', style_class: 'system-status-icon nmw-panel-icon-vpn', visible: false,
        });
        this._panelDown = label('↓ …', 'nmw-panel-speed', {y_align: Clutter.ActorAlign.CENTER});
        this._panelUp = label('↑ …', 'nmw-panel-speed', {y_align: Clutter.ActorAlign.CENTER, opacity: 170});
        box.add_child(this._panelIcon);
        box.add_child(this._panelVpn);
        box.add_child(this._panelDown);
        box.add_child(this._panelUp);
        this.add_child(box);

        this._buildMenu();

        this.menu.connect('open-state-changed', (_m, open) => {
            this._schedule(open ? REFRESH_OPEN : REFRESH_CLOSED);
            if (open) {
                this._lastPing = 0;
                this._refresh();
                this._spark.queue_repaint();
            } else {
                this._radio = null;
                this._setHover(null);
            }
        });
        this._schedule(REFRESH_CLOSED);
        this._initClient();
        this._refresh();
    }

    async _initClient() {
        try {
            const client = await NM.Client.new_async(null);
            if (this._destroyed)
                return;
            this._client = client;
            for (const prop of ['primary-connection', 'activating-connection', 'connectivity',
                'wireless-enabled', 'nm-running', 'active-connections'])
                client.connectObject(`notify::${prop}`, () => this._refresh(), this);
            this._refresh();
        } catch (e) {
            logError(e, 'network-monitor');
        }
    }

    _buildMenu() {
        const section = new PopupMenu.PopupMenuSection();
        this.menu.addMenuItem(section);
        const c = new St.BoxLayout({
            style_class: 'nmw-content',
            orientation: Clutter.Orientation.VERTICAL,
            width: CONTENT_WIDTH,
        });
        section.actor.add_child(c);

        // Hero: network name + status pill, subtitle, signal bar
        const hero = new St.BoxLayout({style_class: 'nmw-hero', orientation: Clutter.Orientation.VERTICAL});
        const top = new St.BoxLayout({x_expand: true});
        this._title = label('Network', 'nmw-title', {x_expand: true, y_align: Clutter.ActorAlign.CENTER});
        this._title.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        const pill = new St.BoxLayout({style_class: 'nmw-pill', y_align: Clutter.ActorAlign.CENTER});
        this._dot = new St.Widget({style_class: 'nmw-dot', y_align: Clutter.ActorAlign.CENTER});
        this._pillLabel = label('', 'nmw-pill-label', {y_align: Clutter.ActorAlign.CENTER});
        pill.add_child(this._dot);
        pill.add_child(this._pillLabel);
        top.add_child(this._title);
        top.add_child(pill);
        this._subtitle = label('', 'nmw-subtitle', {opacity: 190});
        this._subtitle.clutter_text.ellipsize = Pango.EllipsizeMode.END;

        this._barWrap = new St.Bin({style_class: 'nmw-bar-wrap', x_expand: true});
        this._track = new St.Widget({style_class: 'nmw-track', width: CONTENT_WIDTH, height: 10});
        this._fill = new St.Widget({style_class: 'nmw-fill', width: 0, height: 10});
        this._track.add_child(this._fill);
        this._barWrap.set_child(this._track);

        hero.add_child(top);
        hero.add_child(this._subtitle);
        hero.add_child(this._barWrap);
        c.add_child(hero);

        // Traffic graph: download above the line, upload below
        const sparkHead = new St.BoxLayout({x_expand: true});
        this._sparkTitle = label('TRAFFIC', 'nmw-heading', {x_expand: true, opacity: 160});
        sparkHead.add_child(this._sparkTitle);
        const legend = new St.BoxLayout({style_class: 'nmw-legend'});
        for (const [cls, text] of [['down', 'Down'], ['up', 'Up']]) {
            const key = new St.BoxLayout({style_class: 'nmw-key'});
            key.add_child(new St.Widget({style_class: `nmw-key-dot ${cls}`, y_align: Clutter.ActorAlign.CENTER}));
            key.add_child(label(text, 'nmw-heading-value', {opacity: 200, y_align: Clutter.ActorAlign.CENTER}));
            legend.add_child(key);
        }
        sparkHead.add_child(legend);
        this._spark = new St.DrawingArea({style_class: 'nmw-spark', width: CONTENT_WIDTH, height: 64});
        this._spark.connect('repaint', area => this._drawSpark(area));
        const sparkBox = new St.BoxLayout({style_class: 'nmw-block', orientation: Clutter.Orientation.VERTICAL});
        sparkBox.add_child(sparkHead);
        sparkBox.add_child(this._spark);
        c.add_child(sparkBox);

        // Stat tiles
        const grid = new St.Widget({
            style_class: 'nmw-grid',
            layout_manager: new Clutter.GridLayout({column_homogeneous: true, column_spacing: 8, row_spacing: 8}),
        });
        const gl = grid.layout_manager;
        this._stats = {};
        const tile = (key, caption, col, row, span = 1, big = false, dotClass = null) => {
            const t = new St.BoxLayout({style_class: 'nmw-stat', orientation: Clutter.Orientation.VERTICAL, x_expand: true});
            const cap = label(caption, 'nmw-stat-label', {opacity: 160, y_align: Clutter.ActorAlign.CENTER});
            if (dotClass) {
                const capRow = new St.BoxLayout({style_class: 'nmw-key'});
                capRow.add_child(new St.Widget({style_class: `nmw-key-dot ${dotClass}`, y_align: Clutter.ActorAlign.CENTER}));
                capRow.add_child(cap);
                t.add_child(capRow);
            } else {
                t.add_child(cap);
            }
            const v = label('–', big ? 'nmw-stat-value big' : 'nmw-stat-value');
            v.clutter_text.ellipsize = Pango.EllipsizeMode.END;
            t.add_child(v);
            const sub = label('', 'nmw-stat-sub', {opacity: 160, visible: false});
            sub.clutter_text.ellipsize = Pango.EllipsizeMode.END;
            t.add_child(sub);
            gl.attach(t, col, row, span, 1);
            this._stats[key] = {tile: t, caption: cap, value: v, sub};
        };
        tile('down', 'Download', 0, 0, 1, true, 'down');
        tile('up', 'Upload', 1, 0, 1, true, 'up');
        tile('signal', 'Signal', 0, 1);
        tile('link', 'Link speed', 1, 1);
        tile('ip', 'IP address', 0, 2);
        tile('gateway', 'Router', 1, 2);
        tile('latency', 'Internet latency', 0, 3);
        tile('total', 'Transferred', 1, 3);
        tile('dns', 'DNS servers', 0, 4, 2);
        c.add_child(grid);

        // Speed test results: shown once a test has run (or is running)
        const stBlock = new St.BoxLayout({style_class: 'nmw-block', orientation: Clutter.Orientation.VERTICAL, visible: false});
        const stHead = new St.BoxLayout({x_expand: true});
        stHead.add_child(label('SPEED TEST', 'nmw-heading', {x_expand: true, opacity: 160}));
        this._stInfo = label('', 'nmw-heading-value', {opacity: 200});
        stHead.add_child(this._stInfo);
        stBlock.add_child(stHead);
        const stRow = new St.BoxLayout({style_class: 'nmw-st-row', x_expand: true});
        stRow.layout_manager.homogeneous = true;
        this._stTiles = {};
        for (const [key, caption, dotClass] of [['download', 'Download', 'down'], ['upload', 'Upload', 'up'], ['ping', 'Ping', null]]) {
            const t = new St.BoxLayout({style_class: 'nmw-stat', orientation: Clutter.Orientation.VERTICAL, x_expand: true});
            const capRow = new St.BoxLayout({style_class: 'nmw-key'});
            if (dotClass)
                capRow.add_child(new St.Widget({style_class: `nmw-key-dot ${dotClass}`, y_align: Clutter.ActorAlign.CENTER}));
            capRow.add_child(label(caption, 'nmw-stat-label', {opacity: 160, y_align: Clutter.ActorAlign.CENTER}));
            t.add_child(capRow);
            const v = label('–', 'nmw-stat-value');
            v.clutter_text.ellipsize = Pango.EllipsizeMode.END;
            t.add_child(v);
            stRow.add_child(t);
            this._stTiles[key] = v;
        }
        stBlock.add_child(stRow);
        this._stTrack = new St.Widget({style_class: 'nmw-track', width: CONTENT_WIDTH, height: 4, visible: false});
        this._stFill = new St.Widget({style_class: 'nmw-fill', width: 0, height: 4});
        this._stTrack.add_child(this._stFill);
        stBlock.add_child(this._stTrack);
        this._stError = label('', 'nmw-stat-sub', {visible: false});
        this._stError.clutter_text.line_wrap = true;
        stBlock.add_child(this._stError);
        this._stBlock = stBlock;
        c.add_child(stBlock);

        // Quick actions
        const actBlock = new St.BoxLayout({style_class: 'nmw-block', orientation: Clutter.Orientation.VERTICAL});
        actBlock.add_child(label('QUICK ACTIONS', 'nmw-heading', {opacity: 160}));
        const row = new St.BoxLayout({style_class: 'nmw-actions', x_expand: true});
        row.layout_manager.homogeneous = true;
        const action = (id, text, icon, onClick) => {
            const content = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL, x_align: Clutter.ActorAlign.CENTER});
            const ic = new St.Icon({
                ...(typeof icon === 'string' ? {icon_name: icon} : {gicon: icon}),
                style_class: 'nmw-action-icon', x_align: Clutter.ActorAlign.CENTER,
            });
            content.add_child(ic);
            const lbl = label(text, 'nmw-action-label', {x_align: Clutter.ActorAlign.CENTER});
            content.add_child(lbl);
            const btn = new St.Button({
                style_class: 'nmw-action', child: content, can_focus: true, x_expand: true, accessible_name: text,
            });
            btn.connect('clicked', onClick);
            btn.connect('notify::hover', () => this._setHover(btn.hover ? id : null));
            btn.connect('key-focus-in', () => this._setHover(id));
            btn.connect('key-focus-out', () => this._setHover(null));
            row.add_child(btn);
            this._actions[id] = {btn, icon: ic, label: lbl};
        };
        action('wifi', 'Wi-Fi', 'network-wireless-symbolic', () => this._toggleWifi());
        action('copy', 'Copy IP', 'edit-copy-symbolic', () => this._copyIp());
        action('speedtest', 'Speed test', localIcon('nmw-speedtest-symbolic'), () => this._speedTest());
        action('settings', 'Settings', 'emblem-system-symbolic', () => this._openSettings());
        actBlock.add_child(row);
        this._actionDesc = label('', 'nmw-action-desc', {opacity: 200});
        this._actionDesc.clutter_text.line_wrap = true;
        this._actionDesc.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;
        actBlock.add_child(this._actionDesc);
        c.add_child(actBlock);

        this._footer = label('', 'nmw-footer', {opacity: 130});
        c.add_child(this._footer);

        this._st = {running: false, result: loadSpeedTest(), error: null};
        this._renderSpeedTest();
    }

    _schedule(seconds) {
        if (this._timerId)
            GLib.source_remove(this._timerId);
        this._timerId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, seconds, () => {
            this._refresh();
            return GLib.SOURCE_CONTINUE;
        });
        this._interval = seconds;
    }

    async _refresh() {
        if (this._busy) {
            this._again = true;
            return;
        }
        this._busy = true;
        try {
            const conn = readConnection(this._client);
            const traffic = await readTraffic(conn.iface);
            if (this.menu.isOpen && conn.kind === 'wifi')
                this._radio = await readRadio(conn.iface);
            if (this._destroyed)
                return;
            this._conn = conn;
            this._addSample(traffic);
            this._maybePing(conn);
            this._render(conn, traffic);
        } catch (e) {
            logError(e, 'network-monitor');
        } finally {
            this._busy = false;
            if (this._again && !this._destroyed) {
                this._again = false;
                this._refresh();
            }
        }
    }

    _addSample(traffic) {
        const now = GLib.get_monotonic_time() / 1e6;
        const prev = this._sample;
        this._sample = {t: now, ...traffic};
        // Only measure across two readings of the same set of interfaces,
        // so plugging in a dongle doesn't show as a burst of traffic.
        if (!prev || prev.key !== traffic.key || now - prev.t < 0.2) {
            if (!prev || prev.key !== traffic.key)
                this._rate = {down: 0, up: 0};
            return;
        }
        const dt = now - prev.t;
        this._rate = {
            down: Math.max(0, traffic.rx - prev.rx) / dt,
            up: Math.max(0, traffic.tx - prev.tx) / dt,
        };
        this._history.push({t: now, ...this._rate});
        while (this._history.length && this._history[0].t < now - HISTORY_SECONDS)
            this._history.shift();
    }

    async _maybePing(conn) {
        const now = GLib.get_monotonic_time() / 1e6;
        if (!this.menu.isOpen || this._pinging || now - this._lastPing < PING_EVERY)
            return;
        if (!conn.iface || conn.state === 'connecting') {
            this._latency = null;
            return;
        }
        this._pinging = true;
        this._lastPing = now;
        try {
            const [internet, router] = await Promise.all([ping(LATENCY_HOST), ping(conn.gateway)]);
            if (!this._destroyed)
                this._latency = {internet, router, gateway: conn.gateway};
        } finally {
            this._pinging = false;
        }
    }

    _render(c, traffic) {
        const rate = this._rate ?? {down: 0, up: 0};
        const radio = c.kind === 'wifi' ? this._radio : null;

        // panel
        this._panelIcon.icon_name = panelIcon(c);
        this._panelVpn.visible = !!c.vpns?.length;
        this._panelDown.text = `↓ ${fmtRate(rate.down, true)}`;
        this._panelUp.text = `↑ ${fmtRate(rate.up, true)}`;

        // hero
        const [title, pillText, dotClass, subtitle] = describe(c, radio);
        this._title.text = title;
        this._pillLabel.text = pillText;
        this._dot.style_class = `nmw-dot ${dotClass}`;
        this._subtitle.text = subtitle;
        this._subtitle.visible = !!subtitle;

        const strength = c.wifi?.strength ?? null;
        this._barWrap.visible = strength !== null;
        if (strength !== null) {
            const fillW = Math.round(CONTENT_WIDTH * Math.min(strength, 100) / 100);
            if (this.menu.isOpen)
                this._fill.ease({width: fillW, duration: 350, mode: Clutter.AnimationMode.EASE_OUT_QUAD});
            else
                this._fill.width = fillW;
            this._fill.style_class = strength < 35 ? 'nmw-fill weak' : 'nmw-fill';
        }

        // graph
        const span = this._window();
        this._sparkTitle.text = span < 60 ? 'TRAFFIC · JUST STARTED' : `TRAFFIC · LAST ${Math.round(span / 60)} MIN`;
        if (this.menu.isOpen)
            this._spark.queue_repaint();

        // tiles
        const set = (k, v, sub = '', caption = null) => {
            const s = this._stats[k];
            s.value.text = v;
            s.sub.text = sub;
            s.sub.visible = !!sub;
            if (caption)
                s.caption.text = caption;
        };
        const peak = key => this._history.reduce((m, p) => Math.max(m, p[key]), 0);
        set('down', fmtRate(rate.down), `peak ${fmtRate(peak('down'))}`);
        set('up', fmtRate(rate.up), `peak ${fmtRate(peak('up'))}`);

        if (c.kind === 'wifi') {
            const dbm = radio?.dbm ?? null;
            set('signal', dbm !== null ? `${dbm} dBm` : strength !== null ? `${strength}%` : '–',
                strength !== null ? `${dbm !== null ? `${strength}% · ` : ''}${signalWord(dbm, strength)}` : '',
                'Signal');
            const down = radio?.rx ?? c.wifi?.bitrate ?? null;
            set('link', down ? fmtMbps(down) : '–',
                radio?.tx ? `receive · ${fmtMbps(radio.tx)} send` : 'negotiated with the router', 'Link speed');
        } else if (c.kind === 'ethernet') {
            set('signal', 'Cable', 'Ethernet', 'Connection');
            set('link', c.ethSpeed ? fmtMbps(c.ethSpeed) : '–', 'negotiated with the switch', 'Link speed');
        } else {
            set('signal', c.kind === 'modem' ? 'Mobile' : '–', '', 'Connection');
            set('link', '–', '', 'Link speed');
        }

        set('ip', c.ip4?.address ?? c.ip6?.address ?? '–',
            c.ip4 ? [`/${c.ip4.prefix}`, c.ip6 ? 'IPv6 too' : 'no IPv6'].join(' · ') : '');
        const lat = this._latency && this._latency.gateway === c.gateway ? this._latency : null;
        const ms = v => (v === null ? 'no reply' : `${v < 10 ? v.toFixed(1) : Math.round(v)} ms`);
        set('gateway', c.gateway ?? '–', lat ? `ping ${ms(lat.router)}` : c.gateway ? 'ping …' : '');
        set('latency', lat ? ms(lat.internet) : c.iface ? '…' : '–', `ping to ${LATENCY_HOST}`);
        const p = traffic.primary;
        set('total', p ? `↓ ${GLib.format_size(p.rx)}` : '–', p ? `↑ ${GLib.format_size(p.tx)} · since boot` : '');
        set('dns', c.dns?.length ? c.dns.join(' · ') : '–');

        // actions
        const wifi = this._actions.wifi;
        wifi.btn.visible = c.hasWifi;
        wifi.btn.checked = !!c.wifiEnabled;
        wifi.icon.icon_name = c.wifiEnabled ? 'network-wireless-symbolic' : 'network-wireless-disabled-symbolic';
        this._actions.copy.btn.reactive = !!(c.ip4 || c.ip6);
        this._updateDesc();

        this._footer.text = [c.iface, c.hw, `updates every ${this._interval} s`].filter(Boolean).join(' · ');
    }

    _setHover(id) {
        this._hover = id;
        this._updateDesc();
    }

    _updateDesc() {
        const c = this._conn;
        if (!c)
            return;
        if (this._flash) {
            this._actionDesc.text = this._flash;
            return;
        }
        const ip = c.ip4?.address ?? c.ip6?.address;
        const wifiState = c.wifiEnabled
            ? `Wi-Fi is on${c.kind === 'wifi' ? `, connected to ${c.name}` : ''}.`
            : 'Wi-Fi is off.';
        switch (this._hover) {
        case 'wifi':
            this._actionDesc.text = c.wifiEnabled
                ? `Turns Wi-Fi off${c.kind === 'wifi' ? ` and disconnects from ${c.name}` : ''}.`
                : 'Turns Wi-Fi back on.';
            break;
        case 'copy':
            this._actionDesc.text = ip ? `Copies ${ip} to the clipboard.` : 'No IP address to copy yet.';
            break;
        case 'speedtest':
            this._actionDesc.text = this._st.running
                ? 'Stops the speed test.'
                : 'Tests your speed with M-Lab, the test Google uses. Takes 20 s; results are public, including your IP.';
            break;
        case 'settings':
            this._actionDesc.text = `Opens the ${c.hasWifi ? 'Wi-Fi' : 'Network'} page in Settings.`;
            break;
        default:
            this._actionDesc.text = c.hasWifi ? wifiState : '';
        }
    }

    _showFlash(text) {
        this._flash = text;
        this._updateDesc();
        if (this._flashId)
            GLib.source_remove(this._flashId);
        this._flashId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 2, () => {
            this._flashId = 0;
            this._flash = null;
            this._updateDesc();
            return GLib.SOURCE_REMOVE;
        });
    }

    _toggleWifi() {
        if (!this._client)
            return;
        const on = !this._client.wireless_enabled;
        this._client.wireless_enabled = on;
        this._showFlash(on ? 'Turning Wi-Fi on…' : 'Turning Wi-Fi off…');
    }

    _copyIp() {
        const ip = this._conn?.ip4?.address ?? this._conn?.ip6?.address;
        if (!ip)
            return;
        St.Clipboard.get_default().set_text(St.ClipboardType.CLIPBOARD, ip);
        this._showFlash(`Copied ${ip}.`);
    }

    _openSettings() {
        this.menu.close();
        Util.spawn(['gnome-control-center', this._conn?.hasWifi ? 'wifi' : 'network']);
    }

    // Click once to start, again to stop. It keeps running if the popup
    // closes; the result stays until the next test (also across logins).
    async _speedTest() {
        if (this._st.running) {
            this._stCancel?.cancel();
            return;
        }
        const previous = this._st.result;
        this._stCancel = new Gio.Cancellable();
        this._st = {running: true, phase: 'locating', live: 0, fraction: 0, server: null,
            download: null, upload: null, ping: null, result: previous, error: null};
        this._renderSpeedTest();
        try {
            const r = await runSpeedTest({
                cancellable: this._stCancel,
                onProgress: p => {
                    if (this._destroyed || !this._st.running)
                        return;
                    const st = this._st;
                    if (p.phase === 'upload' && st.phase === 'download')
                        st.download = st.live; // download finished
                    if (p.ping !== undefined && p.ping !== null)
                        st.ping = p.ping;
                    Object.assign(st, {phase: p.phase, live: p.mbps, fraction: p.fraction, server: p.server});
                    this._renderSpeedTest();
                },
            });
            if (this._destroyed)
                return;
            const result = {
                download: r.download, upload: r.upload, ping: r.ping,
                city: r.server.city, country: r.server.country, at: r.at.to_unix(),
            };
            saveSpeedTest(result);
            this._st = {running: false, result, error: null};
        } catch (e) {
            if (this._destroyed)
                return;
            const cancelled = e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED);
            this._st = {running: false, result: previous, error: cancelled ? null : e.message};
            if (cancelled)
                this._showFlash('Speed test stopped.');
        } finally {
            this._stCancel = null;
        }
        this._renderSpeedTest();
    }

    _renderSpeedTest() {
        const st = this._st;
        const btn = this._actions.speedtest;
        btn.btn.checked = st.running;
        btn.label.text = st.running ? 'Stop' : 'Speed test';
        btn.icon.gicon = st.running ? Gio.ThemedIcon.new('media-playback-stop-symbolic') : localIcon('nmw-speedtest-symbolic');

        this._stBlock.visible = st.running || !!st.result || !!st.error;
        this._stError.visible = !!st.error;
        this._stError.text = st.error ? `Couldn't run the test: ${st.error}` : '';
        this._stTrack.visible = st.running;

        const t = this._stTiles;
        if (st.running) {
            this._stInfo.text = st.phase === 'locating' ? 'Finding a server…'
                : `Testing ${st.phase} · ${st.server?.city ?? 'M-Lab'}`;
            t.download.text = st.phase === 'download' ? fmtTest(st.live) : st.download !== null ? fmtTest(st.download) : '…';
            t.upload.text = st.phase === 'upload' ? fmtTest(st.live) : '…';
            t.ping.text = st.ping !== null ? fmtMs(st.ping) : '…';
            const overall = st.phase === 'locating' ? 0.02
                : st.phase === 'download' ? st.fraction / 2 : 0.5 + st.fraction / 2;
            this._stFill.width = Math.round(CONTENT_WIDTH * Math.min(1, overall));
        } else if (st.result) {
            const r = st.result;
            this._stInfo.text = [r.city, fmtWhen(r.at)].filter(Boolean).join(' · ');
            t.download.text = fmtTest(r.download);
            t.upload.text = fmtTest(r.upload);
            t.ping.text = r.ping !== null ? fmtMs(r.ping) : '–';
        } else {
            this._stInfo.text = '';
            t.download.text = t.upload.text = t.ping.text = '–';
        }
        this._updateDesc();
    }

    // Seconds shown on the graph: grows from 1 minute up to HISTORY_SECONDS
    // so the line fills the width right after login.
    _window() {
        const first = this._history[0];
        if (!first)
            return 60;
        const age = GLib.get_monotonic_time() / 1e6 - first.t;
        return Math.min(HISTORY_SECONDS, Math.max(60, Math.ceil(age / 60) * 60));
    }

    _drawSpark(area) {
        const cr = area.get_context();
        const [w, h] = area.get_surface_size();
        const fg = area.get_theme_node().get_foreground_color();
        const pts = this._history;
        const now = GLib.get_monotonic_time() / 1e6;
        const win = this._window();
        const pad = 3;
        // Download gets the upper 60%, upload the lower 40%, each on its own
        // scale so a quiet upload is still visible next to a big download.
        const base = Math.round(h * 0.6) + 0.5;
        const floor = 10e3; // 10 kB/s: idle chatter stays near the line
        let maxDown = floor, maxUp = floor;
        for (const p of pts) {
            maxDown = Math.max(maxDown, p.down);
            maxUp = Math.max(maxUp, p.up);
        }
        const x = t => Math.max(0, (t - (now - win)) / win * w);
        const yDown = v => base - v / maxDown * (base - pad);
        const yUp = v => base + v / maxUp * (h - pad - base);

        // zero line
        cr.setSourceRGBA(fg.red / 255, fg.green / 255, fg.blue / 255, 0.25);
        cr.setLineWidth(1);
        cr.setDash([3, 3], 0);
        cr.moveTo(0, base);
        cr.lineTo(w, base);
        cr.stroke();
        cr.setDash([], 0);

        if (pts.length >= 2) {
            for (const [key, y, [r, g, b]] of [['down', yDown, DOWN_RGB], ['up', yUp, UP_RGB]]) {
                cr.moveTo(x(pts[0].t), base);
                for (const p of pts)
                    cr.lineTo(x(p.t), y(p[key]));
                cr.lineTo(x(pts[pts.length - 1].t), base);
                cr.closePath();
                cr.setSourceRGBA(r, g, b, 0.22);
                cr.fill();
                cr.moveTo(x(pts[0].t), y(pts[0][key]));
                for (const p of pts)
                    cr.lineTo(x(p.t), y(p[key]));
                cr.setSourceRGBA(r, g, b, 1);
                cr.setLineWidth(1.75);
                cr.stroke();
                const last = pts[pts.length - 1];
                cr.arc(x(last.t), y(last[key]), 3, 0, 2 * Math.PI);
                cr.fill();
            }
            // scale hints
            cr.setSourceRGBA(fg.red / 255, fg.green / 255, fg.blue / 255, 0.5);
            cr.selectFontFace('Sans', 0, 0);
            cr.setFontSize(9);
            cr.moveTo(2, pad + 9);
            cr.showText(fmtRate(maxDown));
            cr.moveTo(2, h - pad - 1);
            cr.showText(fmtRate(maxUp));
        } else {
            cr.setSourceRGBA(fg.red / 255, fg.green / 255, fg.blue / 255, 0.5);
            cr.selectFontFace('Sans', 0, 0);
            cr.setFontSize(11);
            cr.moveTo(0, h / 2 - 6);
            cr.showText('Collecting samples…');
        }
        cr.$dispose();
    }

    destroy() {
        this._destroyed = true;
        for (const id of ['_timerId', '_flashId']) {
            if (this[id]) {
                GLib.source_remove(this[id]);
                this[id] = 0;
            }
        }
        this._stCancel?.cancel();
        this._client?.disconnectObject(this);
        this._client = null;
        super.destroy();
    }
});

export default class NetworkMonitorExtension extends Extension {
    enable() {
        iconDir = this.dir.get_child('icons');
        this._indicator = new NetworkIndicator();
        Main.panel.addToStatusArea(this.uuid, this._indicator, 0, 'right');
        this._hideSystemNetwork();
    }

    disable() {
        this._restoreSystemNetwork();
        this._indicator?.destroy();
        this._indicator = null;
    }

    // GNOME's own Wi-Fi/wired/VPN icons in the top bar. Only the top-bar
    // icons are hidden; the network toggles in quick settings stay as they are.
    _hideSystemNetwork() {
        const qs = Main.panel.statusArea.quickSettings;
        if (!qs?._system) {
            // Quick settings builds its indicators asynchronously at login;
            // _system is created after _network.
            this._hideRetryId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 250, () => {
                this._hideRetryId = 0;
                this._hideSystemNetwork();
                return GLib.SOURCE_REMOVE;
            });
            return;
        }
        const net = qs._network;
        if (!net)
            return;
        this._systemNetwork = net;
        net.hide();
        // GNOME shows it again whenever its icon changes, so keep it hidden.
        net.connectObject('notify::visible', () => {
            if (net.visible)
                net.hide();
        }, this);
    }

    _restoreSystemNetwork() {
        if (this._hideRetryId) {
            GLib.source_remove(this._hideRetryId);
            this._hideRetryId = 0;
        }
        const net = this._systemNetwork;
        if (!net)
            return;
        net.disconnectObject(this);
        net._syncIndicatorsVisible?.();
        this._systemNetwork = null;
    }
}
