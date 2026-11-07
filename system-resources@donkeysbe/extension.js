// System Resources: a top-bar widget with CPU load and temperature, and a
// popup with memory, storage, temperatures, GPUs, top processes and the
// power mode, in the same style as Battery Charge.

import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import GObject from 'gi://GObject';
import St from 'gi://St';
import Clutter from 'gi://Clutter';
import Pango from 'gi://Pango';
import Shell from 'gi://Shell';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

import {Sampler} from './sysinfo.js';

Gio._promisify(Gio.DBusProxy, 'new_for_bus');
Gio._promisify(Gio.DBusProxy.prototype, 'call');

// What the top bar shows, in order: any of 'cpu', 'temp', 'ram', 'disk'.
// 'temp' is the CPU temperature, shown dimmed after the CPU load.
const PANEL_SHOW = ['cpu', 'temp', 'ram', 'disk'];
// How the top bar shows memory: 'used' (4.2 GB in use) or 'percent' (30%).
const PANEL_RAM = 'used';
// How the top bar shows the main drive: 'free' (426 GB left), 'used'
// (76 GB taken) or 'percent' (15% full).
const PANEL_DISK = 'free';
// The drive changes slowly, so the top bar checks it every 30 s.
const DISK_EVERY = 30;
// CPU temperature (°C) where the status turns Warm and Hot. Laptop chips
// often run at 85-95 °C under load; most are rated for about 100-105 °C.
const WARM_AT = 75;
const HOT_AT = 92;
const HISTORY_SECONDS = 600;
const REFRESH_OPEN = 2;
const REFRESH_CLOSED = 3;
const CONTENT_WIDTH = 340;

const CPU_RGB = [0.21, 0.52, 0.89]; // #3584e4
const MEM_RGB = [0.20, 0.82, 0.48]; // #33d17a

const APPS = ['org.gnome.SystemMonitor.desktop', 'gnome-system-monitor.desktop',
    'net.nokyan.Resources.desktop', 'gnome-system-monitor_gnome-system-monitor.desktop'];

const POWER_MODES = {
    'power-saver': {
        label: 'Power Saver', icon: 'power-profile-power-saver-symbolic',
        desc: 'Lower performance and less heat. The battery lasts longer.',
    },
    'balanced': {
        label: 'Balanced', icon: 'power-profile-balanced-symbolic',
        desc: 'Standard performance and power use.',
    },
    'performance': {
        label: 'Performance', icon: 'power-profile-performance-symbolic',
        desc: 'Highest performance, with more heat, fan noise and battery use.',
    },
};
const DEGRADED = {
    'lap-detected': 'the laptop is on your lap',
    'high-operating-temperature': 'the laptop is too hot',
};

let iconDir = null; // set on enable: the extension's icons/ folder

function localIcon(name) {
    const file = iconDir?.get_child(`${name}.svg`);
    if (file?.query_exists(null))
        return Gio.FileIcon.new(file);
    return Gio.ThemedIcon.new(name);
}

// ---------- formatting ----------

function fmtSize(bytes) {
    return GLib.format_size(Math.max(0, bytes));
}

// For the top bar: 4.2 GB, 14 GB, 426 GB (one decimal only below 10).
function fmtShort(bytes) {
    const units = ['B', 'kB', 'MB', 'GB', 'TB'];
    let v = Math.max(0, bytes), i = 0;
    while (v >= 999.5 && i < units.length - 1) {
        v /= 1000;
        i++;
    }
    return `${i > 0 && v < 9.95 ? v.toFixed(1) : Math.round(v)} ${units[i]}`;
}

function fmtRate(bytesPerSec) {
    return `${GLib.format_size(Math.round(bytesPerSec))}/s`.replace(/^(\d+) bytes\/s$/, '$1 B/s');
}

function fmtGHz(mhz) {
    return `${(mhz / 1000).toFixed(1)} GHz`;
}

function fmtDuration(seconds) {
    const m = Math.floor(seconds / 60);
    const d = Math.floor(m / 1440), h = Math.floor(m % 1440 / 60), min = m % 60;
    if (d)
        return `${d} d ${h} h`;
    return h ? `${h} h ${String(min).padStart(2, '0')} min` : `${min} min`;
}

const deg = c => `${Math.round(c)} °C`;

function thermal(c) {
    if (c === null || c === undefined)
        return null;
    return c >= HOT_AT ? ['Hot', 'hot'] : c >= WARM_AT ? ['Warm', 'warm'] : ['Cool', 'cool'];
}

// ---------- UI ----------

function label(text, styleClass, params = {}) {
    return new St.Label({text, style_class: styleClass, ...params});
}

const SystemIndicator = GObject.registerClass(
class SystemIndicator extends PanelMenu.Button {
    _init() {
        super._init(0.5, 'System Resources', false);
        this._sampler = new Sampler();
        this._history = [];
        this._tileKeys = '';
        this._modeButtons = new Map();
        this._modeList = '';

        // Top bar
        // Each reading gets its own icon, except the temperature, which
        // follows the CPU load in a dimmer, smaller font.
        const box = new St.BoxLayout({style_class: 'panel-status-menu-box'});
        const icons = {
            cpu: localIcon('srw-chip-symbolic'),
            ram: localIcon('srw-memory-symbolic'),
            disk: Gio.ThemedIcon.new_from_names(['drive-harddisk-solidstate-symbolic', 'drive-harddisk-symbolic']),
            temp: PANEL_SHOW.includes('cpu') ? null : localIcon('srw-chip-symbolic'),
        };
        this._panel = {};
        PANEL_SHOW.forEach((key, i) => {
            if (icons[key]) {
                box.add_child(new St.Icon({
                    gicon: icons[key],
                    style_class: i === 0 ? 'system-status-icon' : 'system-status-icon srw-panel-icon',
                }));
            }
            const dim = key === 'temp' && !icons.temp;
            const l = label('…', dim ? 'srw-panel-power' : 'srw-panel-label', {
                y_align: Clutter.ActorAlign.CENTER, opacity: dim ? 170 : 255,
            });
            box.add_child(l);
            this._panel[key] = l;
        });
        this.add_child(box);

        this._buildMenu();

        this.menu.connect('open-state-changed', (_m, open) => {
            this._schedule(open ? REFRESH_OPEN : REFRESH_CLOSED);
            if (open) {
                this._refresh();
                this._spark.queue_repaint();
            } else {
                this._setHover(null);
            }
        });
        this._schedule(REFRESH_CLOSED);
        this._initPowerProfiles();
        this._refresh();
    }

    _buildMenu() {
        const section = new PopupMenu.PopupMenuSection();
        this.menu.addMenuItem(section);
        const c = new St.BoxLayout({
            style_class: 'srw-content',
            orientation: Clutter.Orientation.VERTICAL,
            width: CONTENT_WIDTH,
        });
        section.actor.add_child(c);

        // Hero: CPU % + temperature pill, subtitle, per-thread bars
        const hero = new St.BoxLayout({style_class: 'srw-hero', orientation: Clutter.Orientation.VERTICAL});
        const top = new St.BoxLayout({x_expand: true});
        this._percent = label('–', 'srw-percent');
        top.add_child(this._percent);
        top.add_child(label('CPU', 'srw-percent-unit', {opacity: 160, y_align: Clutter.ActorAlign.END, x_expand: true}));
        const pill = new St.BoxLayout({style_class: 'srw-pill', y_align: Clutter.ActorAlign.CENTER});
        this._dot = new St.Widget({style_class: 'srw-dot', y_align: Clutter.ActorAlign.CENTER});
        this._pillLabel = label('', 'srw-pill-label', {y_align: Clutter.ActorAlign.CENTER});
        pill.add_child(this._dot);
        pill.add_child(this._pillLabel);
        top.add_child(pill);
        this._subtitle = label('', 'srw-subtitle', {opacity: 190});
        this._subtitle.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        this._cores = new St.Widget({width: CONTENT_WIDTH, height: 30});
        const coresWrap = new St.Bin({style_class: 'srw-bar-wrap', x_expand: true, child: this._cores});
        hero.add_child(top);
        hero.add_child(this._subtitle);
        hero.add_child(coresWrap);
        c.add_child(hero);

        // CPU + memory history
        const sparkHead = new St.BoxLayout({x_expand: true});
        this._sparkTitle = label('USAGE', 'srw-heading', {x_expand: true, opacity: 160});
        sparkHead.add_child(this._sparkTitle);
        const legend = new St.BoxLayout({style_class: 'srw-legend'});
        for (const [cls, text] of [['cpu', 'CPU'], ['mem', 'Memory']]) {
            const key = new St.BoxLayout({style_class: 'srw-key'});
            key.add_child(new St.Widget({style_class: `srw-key-dot ${cls}`, y_align: Clutter.ActorAlign.CENTER}));
            key.add_child(label(text, 'srw-heading-value', {opacity: 200, y_align: Clutter.ActorAlign.CENTER}));
            legend.add_child(key);
        }
        sparkHead.add_child(legend);
        this._spark = new St.DrawingArea({width: CONTENT_WIDTH, height: 56});
        this._spark.connect('repaint', area => this._drawSpark(area));
        const sparkBox = new St.BoxLayout({style_class: 'srw-block', orientation: Clutter.Orientation.VERTICAL});
        sparkBox.add_child(sparkHead);
        sparkBox.add_child(this._spark);
        c.add_child(sparkBox);

        // Stat tiles (which ones depends on the hardware)
        this._grid = new St.Widget({
            layout_manager: new Clutter.GridLayout({column_homogeneous: true, column_spacing: 8, row_spacing: 8}),
        });
        c.add_child(this._grid);

        // Top processes
        const procBlock = new St.BoxLayout({style_class: 'srw-block', orientation: Clutter.Orientation.VERTICAL});
        const procHead = new St.BoxLayout({x_expand: true});
        procHead.add_child(label('TOP PROCESSES', 'srw-heading', {x_expand: true, opacity: 160, y_align: Clutter.ActorAlign.CENTER}));
        this._app = APPS.map(id => Shell.AppSystem.get_default().lookup_app(id)).find(Boolean) ?? null;
        if (this._app) {
            const link = new St.Button({
                style_class: 'srw-link', label: `Open ${this._app.get_name()}`, can_focus: true,
            });
            link.connect('clicked', () => {
                this.menu.close();
                this._app.activate();
            });
            procHead.add_child(link);
        }
        procBlock.add_child(procHead);
        this._procBox = new St.BoxLayout({style_class: 'srw-procs', orientation: Clutter.Orientation.VERTICAL});
        this._procRows = [];
        for (let i = 0; i < 4; i++) {
            const row = new St.BoxLayout({style_class: 'srw-proc', x_expand: true});
            const name = label('', 'srw-proc-name', {y_align: Clutter.ActorAlign.CENTER});
            name.clutter_text.ellipsize = Pango.EllipsizeMode.END;
            const count = label('', 'srw-proc-count', {opacity: 140, x_expand: true, y_align: Clutter.ActorAlign.CENTER});
            const mem = label('', 'srw-proc-mem', {opacity: 160, y_align: Clutter.ActorAlign.CENTER});
            mem.clutter_text.x_align = Clutter.ActorAlign.END;
            const cpu = label('', 'srw-proc-cpu', {y_align: Clutter.ActorAlign.CENTER});
            cpu.clutter_text.x_align = Clutter.ActorAlign.END;
            [name, count, mem, cpu].forEach(w => row.add_child(w));
            this._procBox.add_child(row);
            this._procRows.push({row, name, count, mem, cpu});
        }
        procBlock.add_child(this._procBox);
        c.add_child(procBlock);

        // Power mode (power-profiles-daemon)
        const modeBlock = new St.BoxLayout({style_class: 'srw-block', orientation: Clutter.Orientation.VERTICAL, visible: false});
        modeBlock.add_child(label('POWER MODE', 'srw-heading', {opacity: 160}));
        this._modesBox = new St.BoxLayout({style_class: 'srw-modes', x_expand: true});
        this._modesBox.layout_manager.homogeneous = true;
        modeBlock.add_child(this._modesBox);
        this._modeDesc = label('', 'srw-mode-desc', {opacity: 200});
        this._modeDesc.clutter_text.line_wrap = true;
        this._modeDesc.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;
        modeBlock.add_child(this._modeDesc);
        this._modeBlock = modeBlock;
        c.add_child(modeBlock);

        this._footer = label('', 'srw-footer', {opacity: 130});
        this._footer.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        c.add_child(this._footer);
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
            const s = await this._sampler.read(this.menu.isOpen);
            const t = GLib.get_monotonic_time() / 1e6;
            if (s.disks) {
                this._rootDisk = s.disks.find(d => d.mount === '/') ?? s.disks[0] ?? null;
                this._rootDiskAt = t;
            } else if (PANEL_SHOW.includes('disk') && !(t - (this._rootDiskAt ?? -1e9) < DISK_EVERY)) {
                this._rootDisk = await this._sampler.rootDisk();
                this._rootDiskAt = t;
            }
            if (this._destroyed)
                return;
            this._render(s);
        } catch (e) {
            logError(e, 'system-resources');
        } finally {
            this._busy = false;
            if (this._again && !this._destroyed) {
                this._again = false;
                this._refresh();
            }
        }
    }

    _render(s) {
        const cpuTemp = s.temps.find(t => t.key === 'cpu')?.c ?? null;
        const memPct = s.mem.total ? s.mem.used / s.mem.total * 100 : 0;

        // history
        if (s.cpu.ready) {
            const t = GLib.get_monotonic_time() / 1e6;
            this._history.push({t, cpu: s.cpu.usage, mem: memPct});
            while (this._history.length && this._history[0].t < t - HISTORY_SECONDS)
                this._history.shift();
        }

        // panel
        const d = this._rootDisk;
        const panelText = {
            cpu: `${Math.round(s.cpu.usage)}%`,
            ram: PANEL_RAM === 'percent' ? `${Math.round(memPct)}%` : fmtShort(s.mem.used),
            temp: cpuTemp !== null ? `${Math.round(cpuTemp)}°C` : '',
            disk: !d ? '–'
                : PANEL_DISK === 'percent' ? `${Math.round((1 - d.free / d.size) * 100)}%`
                : PANEL_DISK === 'used' ? fmtShort(d.size - d.free)
                : `${fmtShort(d.free)} free`,
        };
        for (const [key, l] of Object.entries(this._panel))
            l.text = panelText[key] ?? '';

        if (!this.menu.isOpen && this._rendered)
            return;
        this._rendered = true;

        // hero
        this._percent.text = `${Math.round(s.cpu.usage)}%`;
        const th = thermal(cpuTemp);
        this._pillLabel.text = th ? `${th[0]} · ${deg(cpuTemp)}` : s.cpu.usage > 70 ? 'Busy' : 'Idle';
        this._dot.style_class = `srw-dot ${th ? th[1] : s.cpu.usage > 70 ? 'warm' : 'cool'}`;
        this._subtitle.text = [s.model, `${s.cpu.perCore.length} threads`,
            s.cpu.freq ? `${fmtGHz(s.cpu.freq.avg)}` : null,
            s.power ? `${s.power.watts.toFixed(1)} W` : null].filter(Boolean).join(' · ');
        this._renderCores(s.cpu.perCore);

        // graph
        const span = this._window();
        this._sparkTitle.text = span < 60 ? 'USAGE · JUST STARTED' : `USAGE · LAST ${Math.round(span / 60)} MIN`;
        this._spark.queue_repaint();

        if (s.disks)
            this._renderTiles(s, memPct);
        if (s.top !== undefined)
            this._renderProcs(s.top);
        this._renderModes();

        this._footer.text = [
            `up ${fmtDuration(s.uptime)}`,
            `${s.procs} processes`,
            `load ${s.load.map(v => v.toFixed(2)).join(' ')}`,
            `every ${this._interval} s`,
        ].join(' · ');
    }

    _renderCores(perCore) {
        const n = perCore.length;
        if (this._coreBars?.length !== n) {
            this._cores.destroy_all_children();
            const gap = n > 32 ? 1 : n > 16 ? 2 : 3;
            const w = (CONTENT_WIDTH - gap * (n - 1)) / n;
            this._coreBars = perCore.map((_, i) => {
                const track = new St.Widget({
                    style_class: 'srw-core-track', x: Math.round(i * (w + gap)), width: Math.max(1, Math.round(w)), height: 30,
                });
                const fill = new St.Widget({style_class: 'srw-core-fill', width: Math.max(1, Math.round(w)), height: 0, y: 30});
                track.add_child(fill);
                this._cores.add_child(track);
                return fill;
            });
        }
        perCore.forEach((v, i) => {
            const h = Math.round(30 * Math.min(100, v) / 100);
            const bar = this._coreBars[i];
            bar.style_class = v > 85 ? 'srw-core-fill busy' : 'srw-core-fill';
            bar.ease({height: h, y: 30 - h, duration: 300, mode: Clutter.AnimationMode.EASE_OUT_QUAD});
        });
    }

    // The tiles depend on what the machine has (GPUs, extra disks, a power
    // sensor), so the grid is laid out from a list.
    _renderTiles(s, memPct) {
        const tiles = [];
        tiles.push(['mem', 'Memory', fmtSize(s.mem.used), `of ${fmtSize(s.mem.total)} · ${Math.round(memPct)}%`]);
        tiles.push(['swap', 'Swap', !s.mem.swapTotal ? 'None' : s.mem.swapUsed < 1048576 ? 'Unused' : fmtSize(s.mem.swapUsed),
            s.mem.swapTotal ? `of ${fmtSize(s.mem.swapTotal)}` : 'no swap space set up']);
        for (const d of s.disks.slice(0, 2)) {
            tiles.push([`disk:${d.mount}`, d.mount === '/' ? 'Storage' : `Storage · ${d.mount}`,
                `${fmtSize(d.free)} free`, `of ${fmtSize(d.size)} · ${Math.round((1 - d.free / d.size) * 100)}% used`]);
        }
        tiles.push(['io', 'Disk activity', fmtRate(s.io.read + s.io.write),
            `read ${fmtRate(s.io.read)} · write ${fmtRate(s.io.write)}`]);
        if (s.temps.length) {
            const cols = s.temps.map(t => [t.label, deg(t.c), thermal(t.key === 'cpu' ? t.c : null)?.[1]]);
            s.fans.forEach((r, i) => cols.push([s.fans.length > 1 ? `Fan ${i + 1}` : 'Fan', `${Math.round(r)} rpm`]));
            tiles.push(['temps', 'Temperatures', cols, '', 2]);
        }
        for (const g of s.gpus) {
            const caption = g.name;
            if (g.asleep) {
                tiles.push([`gpu:${g.name}`, caption, 'Asleep', 'not in use, saving power']);
            } else {
                const sub = [g.temp ? deg(g.temp) : null, g.power ? `${Math.round(g.power)} W` : null,
                    g.memTotal ? `VRAM ${fmtSize(g.memUsed)} of ${fmtSize(g.memTotal)}` : null].filter(Boolean).join(' · ');
                tiles.push([`gpu:${g.name}`, caption, g.busy !== null && g.busy !== undefined ? `${Math.round(g.busy)}% busy` : 'Active', sub]);
            }
        }

        // Lay out: two columns; a tile left alone on its row spans both.
        const placed = [];
        let row = 0, col = 0;
        for (const [key, caption, value, sub, span = 1] of tiles) {
            if (span === 2 && col === 1) {
                placed[placed.length - 1].span = 2;
                row++;
                col = 0;
            }
            placed.push({key, caption, value, sub, row, col, span});
            col += span;
            if (col >= 2) {
                row++;
                col = 0;
            }
        }
        if (col === 1)
            placed[placed.length - 1].span = 2;

        const keys = placed.map(p => `${p.key}@${p.row},${p.col},${p.span}${Array.isArray(p.value) ? `#${p.value.length}` : ''}`).join('|');
        if (keys !== this._tileKeys) {
            this._tileKeys = keys;
            this._grid.destroy_all_children();
            this._tiles = {};
            const gl = this._grid.layout_manager;
            for (const p of placed) {
                const t = new St.BoxLayout({style_class: 'srw-stat', orientation: Clutter.Orientation.VERTICAL, x_expand: true});
                const cap = label('', 'srw-stat-label', {opacity: 160});
                cap.clutter_text.ellipsize = Pango.EllipsizeMode.END;
                const sub = label('', 'srw-stat-sub', {opacity: 160});
                sub.clutter_text.ellipsize = Pango.EllipsizeMode.END;
                let v, cols = null;
                if (Array.isArray(p.value)) {
                    // A row of small readings, e.g. one per temperature sensor
                    v = new St.BoxLayout({style_class: 'srw-cols', x_expand: true});
                    v.layout_manager.homogeneous = true;
                    cols = p.value.map(() => {
                        const col = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL, x_expand: true});
                        const val = label('', 'srw-stat-value');
                        const name = label('', 'srw-stat-sub', {opacity: 160});
                        col.add_child(val);
                        col.add_child(name);
                        v.add_child(col);
                        return {val, name};
                    });
                } else {
                    v = label('', 'srw-stat-value');
                    v.clutter_text.ellipsize = Pango.EllipsizeMode.END;
                }
                [cap, v, sub].forEach(w => t.add_child(w));
                gl.attach(t, p.col, p.row, p.span, 1);
                this._tiles[p.key] = {cap, v, sub, cols};
            }
        }
        for (const p of placed) {
            const t = this._tiles[p.key];
            t.cap.text = p.caption;
            if (t.cols) {
                p.value.forEach(([name, val, cls], i) => {
                    t.cols[i].val.text = val;
                    t.cols[i].name.text = name;
                    t.cols[i].val.style_class = cls ? `srw-stat-value ${cls}` : 'srw-stat-value';
                });
            } else {
                t.v.text = p.value;
            }
            t.sub.text = p.sub;
            t.sub.visible = !!p.sub;
        }
    }

    _renderProcs(top) {
        this._procRows.forEach((r, i) => {
            const p = top?.[i];
            r.row.opacity = p ? 255 : 0;
            r.name.text = p ? p.name : i === 0 ? 'Measuring…' : '';
            r.count.text = p && p.count > 1 ? `×${p.count}` : '';
            r.mem.text = p ? fmtSize(p.mem) : '';
            r.cpu.text = p ? `${p.cpu < 10 ? p.cpu.toFixed(1) : Math.round(p.cpu)}%` : '';
            if (!top && i === 0)
                r.row.opacity = 160;
        });
    }

    // ---------- power mode ----------

    async _initPowerProfiles() {
        for (const [name, path] of [['org.freedesktop.UPower.PowerProfiles', '/org/freedesktop/UPower/PowerProfiles'],
            ['net.hadess.PowerProfiles', '/net/hadess/PowerProfiles']]) {
            try {
                const proxy = await Gio.DBusProxy.new_for_bus(Gio.BusType.SYSTEM, Gio.DBusProxyFlags.NONE,
                    null, name, path, name, null);
                if (this._destroyed)
                    return;
                if (!proxy.get_name_owner())
                    continue;
                this._pp = proxy;
                this._ppIface = name;
                proxy.connectObject('g-properties-changed', () => this._renderModes(), this);
                this._renderModes();
                return;
            } catch {}
        }
    }

    _ppState() {
        const p = this._pp;
        if (!p)
            return null;
        const active = p.get_cached_property('ActiveProfile')?.unpack() ?? null;
        const list = (p.get_cached_property('Profiles')?.recursiveUnpack() ?? []).map(x => x.Profile).filter(Boolean);
        const order = Object.keys(POWER_MODES);
        list.sort((a, b) => order.indexOf(a) - order.indexOf(b));
        const degraded = p.get_cached_property('PerformanceDegraded')?.unpack() ?? '';
        return {active, list, degraded};
    }

    _renderModes() {
        const st = this._ppState();
        this._modeBlock.visible = !!st?.list.length;
        if (!st?.list.length)
            return;
        const key = st.list.join(',');
        if (key !== this._modeList) {
            this._modeList = key;
            this._modesBox.destroy_all_children();
            this._modeButtons.clear();
            for (const id of st.list) {
                const info = POWER_MODES[id] ?? {label: id, icon: 'power-profile-balanced-symbolic', desc: ''};
                const content = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL, x_align: Clutter.ActorAlign.CENTER});
                content.add_child(new St.Icon({icon_name: info.icon, style_class: 'srw-mode-icon', x_align: Clutter.ActorAlign.CENTER}));
                content.add_child(label(info.label, 'srw-mode-label', {x_align: Clutter.ActorAlign.CENTER}));
                const btn = new St.Button({
                    style_class: 'srw-mode', child: content, can_focus: true, x_expand: true,
                    accessible_name: `${info.label} power mode`,
                });
                btn.connect('clicked', () => this._setMode(id));
                btn.connect('notify::hover', () => this._setHover(btn.hover ? id : null));
                btn.connect('key-focus-in', () => this._setHover(id));
                btn.connect('key-focus-out', () => this._setHover(null));
                this._modesBox.add_child(btn);
                this._modeButtons.set(id, btn);
            }
        }
        for (const [id, btn] of this._modeButtons)
            btn.checked = id === st.active;
        this._updateDesc();
    }

    _setHover(id) {
        this._hover = id;
        this._updateDesc();
    }

    _updateDesc() {
        const st = this._ppState();
        if (!st)
            return;
        if (this._modeError) {
            this._modeDesc.text = this._modeError;
            return;
        }
        const id = this._hover ?? st.active;
        const info = POWER_MODES[id] ?? {label: id ?? '', desc: ''};
        let text = `${id === st.active ? 'Active' : info.label} · ${info.desc}`;
        if (id === 'performance' && st.degraded)
            text = `${text} Limited right now: ${DEGRADED[st.degraded] ?? st.degraded}.`;
        this._modeDesc.text = id ? text : '';
    }

    async _setMode(id) {
        if (!this._pp)
            return;
        this._modeError = null;
        try {
            await this._pp.call('org.freedesktop.DBus.Properties.Set',
                new GLib.Variant('(ssv)', [this._ppIface, 'ActiveProfile', new GLib.Variant('s', id)]),
                Gio.DBusCallFlags.NONE, -1, null);
        } catch (e) {
            if (this._destroyed)
                return;
            this._modeError = `Couldn't switch: ${Gio.DBusError.strip_remote_error(e) ?? e.message}`;
            GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 4, () => {
                this._modeError = null;
                if (!this._destroyed)
                    this._updateDesc();
                return GLib.SOURCE_REMOVE;
            });
        }
        if (!this._destroyed)
            this._renderModes();
    }

    // ---------- graph ----------

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
        const x = t => Math.max(0, (t - (now - win)) / win * w);
        const y = v => pad + (100 - Math.min(100, v)) / 100 * (h - 2 * pad);

        // 0, 50 and 100% guides
        cr.setSourceRGBA(fg.red / 255, fg.green / 255, fg.blue / 255, 0.18);
        cr.setLineWidth(1);
        cr.setDash([3, 3], 0);
        for (const v of [0, 50, 100]) {
            cr.moveTo(0, Math.round(y(v)) + 0.5);
            cr.lineTo(w, Math.round(y(v)) + 0.5);
        }
        cr.stroke();
        cr.setDash([], 0);

        if (pts.length >= 2) {
            // CPU: filled area
            const [r, g, b] = CPU_RGB;
            cr.moveTo(x(pts[0].t), y(0));
            for (const p of pts)
                cr.lineTo(x(p.t), y(p.cpu));
            cr.lineTo(x(pts[pts.length - 1].t), y(0));
            cr.closePath();
            cr.setSourceRGBA(r, g, b, 0.22);
            cr.fill();
            cr.moveTo(x(pts[0].t), y(pts[0].cpu));
            for (const p of pts)
                cr.lineTo(x(p.t), y(p.cpu));
            cr.setSourceRGBA(r, g, b, 1);
            cr.setLineWidth(1.75);
            cr.stroke();
            // Memory: line only
            const [mr, mg, mb] = MEM_RGB;
            cr.moveTo(x(pts[0].t), y(pts[0].mem));
            for (const p of pts)
                cr.lineTo(x(p.t), y(p.mem));
            cr.setSourceRGBA(mr, mg, mb, 1);
            cr.setLineWidth(1.5);
            cr.stroke();
            const last = pts[pts.length - 1];
            cr.arc(x(last.t), y(last.cpu), 3, 0, 2 * Math.PI);
            cr.setSourceRGBA(r, g, b, 1);
            cr.fill();
            // scale hint
            cr.setSourceRGBA(fg.red / 255, fg.green / 255, fg.blue / 255, 0.5);
            cr.selectFontFace('Sans', 0, 0);
            cr.setFontSize(9);
            cr.moveTo(2, pad + 9);
            cr.showText('100%');
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
        if (this._timerId) {
            GLib.source_remove(this._timerId);
            this._timerId = 0;
        }
        this._pp?.disconnectObject(this);
        this._pp = null;
        super.destroy();
    }
});

export default class SystemResourcesExtension extends Extension {
    enable() {
        iconDir = this.dir.get_child('icons');
        this._indicator = new SystemIndicator();
        Main.panel.addToStatusArea(this.uuid, this._indicator, 0, 'right');
    }

    disable() {
        this._indicator?.destroy();
        this._indicator = null;
    }
}
