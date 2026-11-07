// Battery Charge: a top-bar widget with live battery/charger readings
// and a charge-mode switch (charge_types in /sys/class/power_supply).

import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import GObject from 'gi://GObject';
import St from 'gi://St';
import Clutter from 'gi://Clutter';
import Pango from 'gi://Pango';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

Gio._promisify(Gio.File.prototype, 'load_contents_async');
Gio._promisify(Gio.Subprocess.prototype, 'communicate_utf8_async');

// Overridable so the widget can be tried against recorded data.
const PS = GLib.getenv('BCW_POWER_SUPPLY_DIR') || '/sys/class/power_supply';
// Where Lenovo IdeaPad "Conservation Mode" stops charging (55-60% on 2021 models).
const LONG_LIFE_LIMIT = 60;
const HISTORY_SECONDS = 600;
const REFRESH_OPEN = 2;
const REFRESH_CLOSED = 5;
const CONTENT_WIDTH = 340;

const MODES = {
    Long_Life: {
        label: 'Long Life',
        icon: 'bcw-long-life-symbolic',
        desc: `Stops charging around ${LONG_LIFE_LIMIT}%. Best for battery health when you're plugged in most of the time.`,
    },
    Standard: {
        label: 'Standard',
        icon: 'bcw-standard-symbolic',
        desc: 'Charges normally up to 100%. Use it before a day away from the charger.',
    },
    Fast: {
        label: 'Fast',
        icon: 'bcw-fast-symbolic',
        desc: 'Charges with more current: quicker, but more heat and battery wear.',
    },
    Trickle: {label: 'Trickle', icon: 'battery-level-30-charging-symbolic', desc: 'Charges very slowly.'},
    Adaptive: {label: 'Adaptive', icon: 'emblem-system-symbolic', desc: 'The firmware decides how to charge.'},
};

const MODE_ORDER = Object.keys(MODES);
let iconDir = null; // set on enable: the extension's icons/ folder

function modeInfo(id) {
    return MODES[id] ?? {label: id.replace(/_/g, ' '), icon: 'battery-symbolic', desc: ''};
}

function modeIcon(name) {
    const file = iconDir?.get_child(`${name}.svg`);
    if (file?.query_exists(null))
        return Gio.FileIcon.new(file);
    return Gio.ThemedIcon.new(name);
}

function sortModes(list) {
    const rank = id => (MODE_ORDER.includes(id) ? MODE_ORDER.indexOf(id) : MODE_ORDER.length);
    return [...list].sort((a, b) => rank(a) - rank(b));
}

// ---------- reading sysfs ----------

async function readText(path) {
    try {
        const [bytes] = await Gio.File.new_for_path(path).load_contents_async(null);
        return new TextDecoder().decode(bytes).trim();
    } catch {
        return null;
    }
}

function listSupplies() {
    const names = [];
    try {
        const dir = GLib.Dir.open(PS, 0);
        let n;
        while ((n = dir.read_name()) !== null)
            names.push(n);
        dir.close();
    } catch {}
    return names;
}

function parseUevent(text) {
    const o = {};
    for (const line of text.split('\n')) {
        const i = line.indexOf('=');
        if (i > 0)
            o[line.slice(0, i).replace(/^POWER_SUPPLY_/, '')] = line.slice(i + 1);
    }
    return o;
}

function canWrite(path) {
    try {
        return Gio.File.new_for_path(path)
            .query_info('access::can-write', Gio.FileQueryInfoFlags.NONE, null)
            .get_attribute_boolean('access::can-write');
    } catch {
        return false;
    }
}

async function readState() {
    const supplies = (await Promise.all(listSupplies().map(async name => {
        const t = await readText(`${PS}/${name}/uevent`);
        return t ? {name, ...parseUevent(t)} : null;
    }))).filter(Boolean);

    const raw = supplies.find(s => s.TYPE === 'Battery' && s.PRESENT !== '0' &&
        (s.SCOPE ?? 'System') === 'System');
    if (!raw)
        return {bat: null};

    const num = k => (raw[k] !== undefined && raw[k] !== '' ? Number(raw[k]) : null);
    const voltage = (num('VOLTAGE_NOW') ?? 0) / 1e6;                 // V
    const vDesign = (num('VOLTAGE_MIN_DESIGN') ?? num('VOLTAGE_NOW') ?? 0) / 1e6;
    let power = num('POWER_NOW') !== null ? Math.abs(num('POWER_NOW')) / 1e6 : null; // W
    let current = num('CURRENT_NOW') !== null ? Math.abs(num('CURRENT_NOW')) / 1e6 : null; // A
    if (power === null && current !== null)
        power = current * voltage;
    if (current === null && power !== null && voltage > 0)
        current = power / voltage;

    const wh = (e, c) => (num(e) !== null ? num(e) / 1e6 : num(c) !== null ? num(c) / 1e6 * vDesign : null);
    const energy = wh('ENERGY_NOW', 'CHARGE_NOW');
    const energyFull = wh('ENERGY_FULL', 'CHARGE_FULL');
    const energyDesign = wh('ENERGY_FULL_DESIGN', 'CHARGE_FULL_DESIGN');
    const status = raw.STATUS ?? 'Unknown';
    const signed = (power ?? 0) * (status === 'Discharging' ? -1 : 1);

    const bat = {
        name: raw.name,
        model: [raw.MANUFACTURER, raw.MODEL_NAME].filter(Boolean).join(' '),
        technology: raw.TECHNOLOGY,
        status,
        capacity: num('CAPACITY') ?? (energy && energyFull ? Math.round(energy / energyFull * 100) : 0),
        voltage, current, power: signed,
        energy, energyFull, energyDesign,
        amphours: energyFull && vDesign ? energyFull / vDesign : null,
        health: energyFull && energyDesign ? energyFull / energyDesign * 100 : null,
        cycles: num('CYCLE_COUNT'),
    };

    let modes = null;
    const ctPath = `${PS}/${raw.name}/charge_types`;
    const ct = await readText(ctPath);
    if (ct) {
        const list = ct.split(/\s+/).filter(Boolean);
        const active = list.find(m => m.startsWith('['))?.slice(1, -1) ?? null;
        modes = {list: sortModes(list.map(m => m.replace(/[[\]]/g, ''))), active, writable: canWrite(ctPath)};
    }

    let charger = null;
    const online = supplies.filter(s => s.ONLINE === '1' && s.TYPE !== 'Battery');
    const usb = online.find(s => s.TYPE?.startsWith('USB'));
    if (usb) {
        const pd = /PD/.test(usb.USB_TYPE ?? '');
        const now = usb.CURRENT_NOW ? Number(usb.CURRENT_NOW) / 1e6 : null;
        const max = usb.CURRENT_MAX ? Number(usb.CURRENT_MAX) / 1e6 : null;
        charger = {
            title: pd ? 'USB-C Power Delivery' : 'USB charger',
            detail: [now ? `${now.toFixed(2)} A` : null, max ? `max ${trim(max)} A` : null]
                .filter(Boolean).join(' · '),
        };
    } else if (online.length) {
        // The OEM round-plug adapter only reports "online" (ACPI ACAD):
        // no volts, amps or wattage.
        charger = {title: 'Power adapter (DC-in)', detail: 'The adapter doesn\'t report amps or watts'};
    }

    return {bat, modes, charger};
}

// ---------- writing ----------

async function run(argv, input = null) {
    const proc = Gio.Subprocess.new(argv,
        Gio.SubprocessFlags.STDIN_PIPE | Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE);
    const [, , stderr] = await proc.communicate_utf8_async(input, null);
    if (!proc.get_successful()) {
        const err = new Error((stderr ?? '').trim() || `exit code ${proc.get_exit_status()}`);
        err.status = proc.get_exit_status();
        throw err;
    }
}

async function writeMode(batName, mode, writable) {
    const path = `${PS}/${batName}/charge_types`;
    if (writable) {
        await run(['/bin/sh', '-c', 'printf "%s" "$1" > "$2"', 'sh', mode, path]);
        return;
    }
    // No direct write access: ask for the admin password through polkit.
    try {
        await run(['pkexec', '/usr/bin/tee', path], mode);
    } catch (e) {
        if (e.status === 126 || e.status === 127)
            e.cancelled = true;
        throw e;
    }
}

// ---------- formatting ----------

function trim(v) {
    return Number.isInteger(v) ? String(v) : v.toFixed(2).replace(/0+$/, '').replace(/\.$/, '');
}

function fmtW(v) {
    const a = Math.abs(v);
    return `${a < 10 ? a.toFixed(2) : a.toFixed(1)} W`;
}

function fmtDuration(hours) {
    const m = Math.round(hours * 60);
    if (m < 1)
        return 'under a minute';
    const h = Math.floor(m / 60);
    return h ? `${h} h ${String(m % 60).padStart(2, '0')} min` : `${m} min`;
}

// What the battery is doing, in words: [pill text, dot class, subtitle].
function describe(bat, mode) {
    const p = Math.abs(bat.power);
    const longLife = mode === 'Long_Life';
    const target = longLife ? LONG_LIFE_LIMIT : 100;
    // Long Life doesn't drain a fuller battery down; it just stops charging.
    const held = bat.capacity > LONG_LIFE_LIMIT + 2
        ? `Paused · Long Life doesn't charge above ${LONG_LIFE_LIMIT}%`
        : `Held near ${LONG_LIFE_LIMIT}% to protect the battery`;
    switch (bat.status) {
    case 'Discharging':
        return ['On battery', 'discharging',
            p > 0.3 && bat.energy ? `${fmtDuration(bat.energy / p)} left at ${fmtW(p)}` : 'Running on battery'];
    case 'Full':
        return ['Full', 'full', 'Fully charged'];
    case 'Not charging':
        return longLife
            ? ['Holding', 'holding', held]
            : ['Plugged in', 'holding', 'Plugged in, not charging'];
    case 'Charging': {
        if (longLife && bat.capacity >= target - 5 && p < 1)
            return ['Holding', 'holding', held];
        if (p > 0.3 && bat.energyFull && bat.energy !== null) {
            const left = (bat.energyFull * target / 100 - bat.energy) / p;
            if (left > 0 && left < 48)
                return ['Charging', 'charging', `${fmtDuration(left)} to ${target}% at ${fmtW(p)}`];
        }
        return ['Charging', 'charging', 'Charging'];
    }
    default:
        return [bat.status, 'idle', ''];
    }
}

// ---------- UI ----------

function label(text, styleClass, params = {}) {
    return new St.Label({text, style_class: styleClass, ...params});
}

const BatteryIndicator = GObject.registerClass(
class BatteryIndicator extends PanelMenu.Button {
    _init() {
        super._init(0.5, 'Battery Charge', false);
        this._history = [];
        this._modeButtons = new Map();
        this._modeList = '';
        this._switching = null;
        this._message = null;

        // Top bar
        const box = new St.BoxLayout({style_class: 'panel-status-menu-box'});
        this._panelIcon = new St.Icon({icon_name: 'battery-missing-symbolic', style_class: 'system-status-icon'});
        this._panelLabel = label('…', 'bcw-panel-label', {y_align: Clutter.ActorAlign.CENTER});
        this._panelPower = label('', 'bcw-panel-power', {y_align: Clutter.ActorAlign.CENTER, opacity: 170});
        box.add_child(this._panelIcon);
        box.add_child(this._panelLabel);
        box.add_child(this._panelPower);
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
        this._refresh();
    }

    _buildMenu() {
        const section = new PopupMenu.PopupMenuSection();
        this.menu.addMenuItem(section);
        const c = new St.BoxLayout({
            style_class: 'bcw-content',
            orientation: Clutter.Orientation.VERTICAL,
            width: CONTENT_WIDTH,
        });
        section.actor.add_child(c);

        // Hero: big percentage + status pill, subtitle, level bar
        const hero = new St.BoxLayout({style_class: 'bcw-hero', orientation: Clutter.Orientation.VERTICAL});
        const top = new St.BoxLayout({x_expand: true});
        this._percent = label('–', 'bcw-percent', {x_expand: true});
        const pill = new St.BoxLayout({style_class: 'bcw-pill', y_align: Clutter.ActorAlign.CENTER});
        this._dot = new St.Widget({style_class: 'bcw-dot', y_align: Clutter.ActorAlign.CENTER});
        this._pillLabel = label('', 'bcw-pill-label', {y_align: Clutter.ActorAlign.CENTER});
        pill.add_child(this._dot);
        pill.add_child(this._pillLabel);
        top.add_child(this._percent);
        top.add_child(pill);
        this._subtitle = label('', 'bcw-subtitle', {opacity: 190});
        this._subtitle.clutter_text.ellipsize = Pango.EllipsizeMode.END;

        const barWrap = new St.Bin({style_class: 'bcw-bar-wrap', x_expand: true});
        this._track = new St.Widget({style_class: 'bcw-track', width: CONTENT_WIDTH, height: 10});
        this._fill = new St.Widget({style_class: 'bcw-fill', width: 0, height: 10});
        this._marker = new St.Widget({style_class: 'bcw-marker', width: 3, height: 18, y: -4, visible: false});
        this._track.add_child(this._fill);
        this._track.add_child(this._marker);
        barWrap.set_child(this._track);

        hero.add_child(top);
        hero.add_child(this._subtitle);
        hero.add_child(barWrap);
        c.add_child(hero);

        // Power history sparkline
        const sparkHead = new St.BoxLayout({x_expand: true});
        this._sparkTitle = label('POWER', 'bcw-heading', {x_expand: true, opacity: 160});
        sparkHead.add_child(this._sparkTitle);
        this._sparkValue = label('', 'bcw-heading-value');
        sparkHead.add_child(this._sparkValue);
        this._spark = new St.DrawingArea({style_class: 'bcw-spark', width: CONTENT_WIDTH, height: 56});
        this._spark.connect('repaint', area => this._drawSpark(area));
        const sparkBox = new St.BoxLayout({style_class: 'bcw-block', orientation: Clutter.Orientation.VERTICAL});
        sparkBox.add_child(sparkHead);
        sparkBox.add_child(this._spark);
        c.add_child(sparkBox);

        // Stat tiles
        const grid = new St.Widget({
            style_class: 'bcw-grid',
            layout_manager: new Clutter.GridLayout({column_homogeneous: true, column_spacing: 8, row_spacing: 8}),
        });
        const gl = grid.layout_manager;
        this._stats = {};
        const tile = (key, caption, col, row, span = 1) => {
            const t = new St.BoxLayout({style_class: 'bcw-stat', orientation: Clutter.Orientation.VERTICAL, x_expand: true});
            t.add_child(label(caption, 'bcw-stat-label', {opacity: 160}));
            const v = label('–', 'bcw-stat-value');
            v.clutter_text.ellipsize = Pango.EllipsizeMode.END;
            t.add_child(v);
            const sub = label('', 'bcw-stat-sub', {opacity: 160, visible: false});
            sub.clutter_text.ellipsize = Pango.EllipsizeMode.END;
            t.add_child(sub);
            gl.attach(t, col, row, span, 1);
            this._stats[key] = {value: v, sub};
        };
        tile('voltage', 'Voltage', 0, 0);
        tile('current', 'Current', 1, 0);
        tile('energy', 'Energy', 0, 1);
        tile('capacity', 'Full capacity', 1, 1);
        tile('health', 'Health', 0, 2);
        tile('cycles', 'Charge cycles', 1, 2);
        tile('charger', 'Charger', 0, 3, 2);
        c.add_child(grid);

        // Charge mode selector
        const modeBlock = new St.BoxLayout({style_class: 'bcw-block', orientation: Clutter.Orientation.VERTICAL});
        modeBlock.add_child(label('CHARGE MODE', 'bcw-heading', {opacity: 160}));
        this._modesBox = new St.BoxLayout({style_class: 'bcw-modes', x_expand: true});
        this._modesBox.layout_manager.homogeneous = true;
        modeBlock.add_child(this._modesBox);
        this._modeDesc = label('', 'bcw-mode-desc', {opacity: 200});
        this._modeDesc.clutter_text.line_wrap = true;
        this._modeDesc.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;
        modeBlock.add_child(this._modeDesc);
        const msgRow = new St.BoxLayout({style_class: 'bcw-message', visible: false});
        this._msgIcon = new St.Icon({icon_name: 'dialog-information-symbolic', style_class: 'bcw-message-icon'});
        this._msgLabel = label('', 'bcw-message-label', {x_expand: true, y_align: Clutter.ActorAlign.CENTER});
        this._msgLabel.clutter_text.line_wrap = true;
        msgRow.add_child(this._msgIcon);
        msgRow.add_child(this._msgLabel);
        this._msgRow = msgRow;
        modeBlock.add_child(msgRow);
        this._modeBlock = modeBlock;
        c.add_child(modeBlock);

        this._footer = label('', 'bcw-footer', {opacity: 130});
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
            const s = await readState();
            if (this._destroyed)
                return;
            this._state = s;
            this._render(s);
        } catch (e) {
            logError(e, 'battery-charge');
        } finally {
            this._busy = false;
            if (this._again && !this._destroyed) {
                this._again = false;
                this._refresh();
            }
        }
    }

    _render({bat, modes, charger}) {
        if (!bat) {
            this._panelIcon.icon_name = 'battery-missing-symbolic';
            this._panelLabel.text = '';
            this._panelPower.text = '';
            this._percent.text = 'No battery';
            return;
        }

        // history
        const now = GLib.get_monotonic_time() / 1e6;
        this._history.push({t: now, w: bat.power});
        while (this._history.length && this._history[0].t < now - HISTORY_SECONDS)
            this._history.shift();

        // panel
        const cap = Math.round(bat.capacity);
        const level = Math.max(0, Math.min(100, Math.round(cap / 10) * 10));
        const plugged = !!charger || bat.status !== 'Discharging';
        let suffix = '';
        if (plugged)
            suffix = level === 100 ? '-charged' : '-charging';
        this._panelIcon.icon_name = `battery-level-${level}${suffix}-symbolic`;
        this._panelLabel.text = `${cap}%`;
        this._panelPower.text = Math.abs(bat.power) >= 0.5
            ? `${bat.power > 0 ? '+' : '−'}${fmtW(bat.power)}` : '';

        // hero
        const active = modes?.active ?? null;
        const [pillText, dotClass, subtitle] = describe(bat, active);
        this._percent.text = `${cap}%`;
        this._pillLabel.text = pillText;
        this._dot.style_class = `bcw-dot ${dotClass}`;
        this._subtitle.text = subtitle;

        const fillW = Math.round(CONTENT_WIDTH * Math.min(cap, 100) / 100);
        if (this.menu.isOpen)
            this._fill.ease({width: fillW, duration: 350, mode: Clutter.AnimationMode.EASE_OUT_QUAD});
        else
            this._fill.width = fillW;
        this._fill.style_class = cap <= 15 && bat.status === 'Discharging' ? 'bcw-fill low' : 'bcw-fill';
        this._marker.visible = active === 'Long_Life';
        this._marker.x = Math.round(CONTENT_WIDTH * LONG_LIFE_LIMIT / 100) - 1;

        // sparkline
        this._sparkValue.text = `${bat.power > 0.005 ? '+' : bat.power < -0.005 ? '−' : ''}${fmtW(bat.power)}`;
        const span = this._window();
        this._sparkTitle.text = span < 60 ? 'BATTERY POWER · JUST STARTED'
            : `BATTERY POWER · LAST ${Math.round(span / 60)} MIN`;
        if (this.menu.isOpen)
            this._spark.queue_repaint();

        // stats
        const set = (k, v, sub = '') => {
            this._stats[k].value.text = v;
            this._stats[k].sub.text = sub;
            this._stats[k].sub.visible = !!sub;
        };
        set('voltage', bat.voltage ? `${bat.voltage.toFixed(2)} V` : '–');
        set('current', bat.current !== null ? `${bat.current.toFixed(bat.current < 1 ? 3 : 2)} A` : '–',
            bat.status === 'Discharging' ? 'out of battery' : bat.current > 0.001 ? 'into battery' : '');
        set('energy', bat.energy !== null ? `${bat.energy.toFixed(1)} Wh` : '–',
            bat.energyFull ? `of ${bat.energyFull.toFixed(1)} Wh` : '');
        set('capacity', bat.amphours ? `${bat.amphours.toFixed(2)} Ah` : '–',
            bat.energyFull ? `${bat.energyFull.toFixed(1)} Wh` : '');
        set('health', bat.health ? `${Math.round(bat.health)}%` : '–',
            bat.energyDesign ? `design ${bat.energyDesign.toFixed(1)} Wh` : '');
        set('cycles', bat.cycles !== null ? String(bat.cycles) : '–');
        set('charger', charger ? charger.title : 'Not connected', charger?.detail ?? '');

        // modes
        this._modeBlock.visible = !!modes;
        if (modes)
            this._renderModes(modes);

        this._footer.text = [bat.name, bat.technology, bat.model, `updates every ${this._interval} s`]
            .filter(Boolean).join(' · ');
    }

    _renderModes(modes) {
        const key = modes.list.join(',');
        if (key !== this._modeList) {
            this._modeList = key;
            this._modesBox.destroy_all_children();
            this._modeButtons.clear();
            for (const id of modes.list) {
                const info = modeInfo(id);
                const content = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL, x_align: Clutter.ActorAlign.CENTER});
                content.add_child(new St.Icon({gicon: modeIcon(info.icon), style_class: 'bcw-mode-icon', x_align: Clutter.ActorAlign.CENTER}));
                content.add_child(label(info.label, 'bcw-mode-label', {x_align: Clutter.ActorAlign.CENTER}));
                const btn = new St.Button({
                    style_class: 'bcw-mode', child: content, can_focus: true, x_expand: true,
                    accessible_name: `${info.label} charge mode`,
                });
                btn.connect('clicked', () => this._setMode(id));
                btn.connect('notify::hover', () => this._setHover(btn.hover ? id : null));
                btn.connect('key-focus-in', () => this._setHover(id));
                btn.connect('key-focus-out', () => this._setHover(null));
                this._modesBox.add_child(btn);
                this._modeButtons.set(id, btn);
            }
        }
        for (const [id, btn] of this._modeButtons) {
            btn.checked = id === (this._switching ?? modes.active);
            btn.reactive = !this._switching;
        }
        this._updateDesc();
        this._updateMessage();
    }

    _setHover(id) {
        this._hover = id;
        this._updateDesc();
    }

    _updateDesc() {
        const modes = this._state?.modes;
        if (!modes)
            return;
        if (this._switching) {
            this._modeDesc.text = `Switching to ${modeInfo(this._switching).label}…`;
            return;
        }
        const id = this._hover ?? modes.active;
        const info = modeInfo(id ?? '');
        const prefix = id === modes.active ? 'Active · ' : `${info.label} · `;
        this._modeDesc.text = id ? `${prefix}${info.desc}` : '';
    }

    _updateMessage() {
        let msg = this._message;
        if (!msg && this._state?.modes && !this._state.modes.writable)
            msg = {text: 'Switching will ask for your password. Run install.sh once to switch without it.', error: false};
        this._msgRow.visible = !!msg;
        if (msg) {
            this._msgLabel.text = msg.text;
            this._msgIcon.icon_name = msg.error ? 'dialog-warning-symbolic' : 'dialog-information-symbolic';
            this._msgRow.style_class = msg.error ? 'bcw-message error' : 'bcw-message';
        }
    }

    async _setMode(id) {
        const st = this._state;
        if (!st?.modes || this._switching || id === st.modes.active)
            return;
        this._switching = id;
        this._message = null;
        this._renderModes(st.modes);
        try {
            await writeMode(st.bat.name, id, st.modes.writable);
        } catch (e) {
            if (this._destroyed)
                return;
            this._message = {text: e.cancelled ? 'Switch cancelled.' : `Couldn't switch: ${e.message}`, error: true};
        }
        if (this._destroyed)
            return;
        this._switching = null;
        await this._refresh();
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

        let lo = 0, hi = 0;
        for (const p of pts) {
            lo = Math.min(lo, p.w);
            hi = Math.max(hi, p.w);
        }
        if (hi - lo < 2) {
            if (hi > 0 || lo === 0)
                hi = lo + 2;
            else
                lo = hi - 2;
        }
        const y = v => pad + (hi - v) / (hi - lo) * (h - 2 * pad);
        const x = t => Math.max(0, (t - (now - win)) / win * w);
        const base = y(0);

        // zero line
        cr.setSourceRGBA(fg.red / 255, fg.green / 255, fg.blue / 255, 0.25);
        cr.setLineWidth(1);
        cr.setDash([3, 3], 0);
        cr.moveTo(0, Math.round(base) + 0.5);
        cr.lineTo(w, Math.round(base) + 0.5);
        cr.stroke();
        cr.setDash([], 0);

        if (pts.length >= 2) {
            const area_ = () => {
                cr.moveTo(x(pts[0].t), base);
                for (const p of pts)
                    cr.lineTo(x(p.t), y(p.w));
                cr.lineTo(x(pts[pts.length - 1].t), base);
                cr.closePath();
            };
            const line = () => {
                cr.moveTo(x(pts[0].t), y(pts[0].w));
                for (const p of pts)
                    cr.lineTo(x(p.t), y(p.w));
            };
            // Neutral line first, so stretches at ~0 W stay grey...
            line();
            cr.setSourceRGBA(fg.red / 255, fg.green / 255, fg.blue / 255, 0.55);
            cr.setLineWidth(1.75);
            cr.stroke();
            // ...then colour what is clearly above or below zero.
            const parts = [
                [0, base - 1.5, [0.18, 0.76, 0.49]],              // charging: green
                [base + 1.5, h - base - 1.5, [0.96, 0.65, 0.14]], // discharging: amber
            ];
            for (const [ry, rh, [r, g, b]] of parts) {
                if (rh <= 0)
                    continue;
                cr.save();
                cr.rectangle(0, ry, w, rh);
                cr.clip();
                area_();
                cr.setSourceRGBA(r, g, b, 0.22);
                cr.fill();
                line();
                cr.setSourceRGBA(r, g, b, 1);
                cr.setLineWidth(1.75);
                cr.stroke();
                cr.restore();
            }
            // current point
            const last = pts[pts.length - 1];
            cr.arc(x(last.t), y(last.w), 3, 0, 2 * Math.PI);
            cr.setSourceRGBA(fg.red / 255, fg.green / 255, fg.blue / 255, 0.9);
            cr.fill();
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
        super.destroy();
    }
});

export default class BatteryChargeExtension extends Extension {
    enable() {
        iconDir = this.dir.get_child('icons');
        this._indicator = new BatteryIndicator();
        Main.panel.addToStatusArea(this.uuid, this._indicator, 0, 'right');
        this._hideSystemBattery();
    }

    disable() {
        this._restoreSystemBattery();
        this._indicator?.destroy();
        this._indicator = null;
    }

    // GNOME's own battery icon + percentage at the far right of the top bar.
    // Only the top-bar part is hidden; the battery toggle inside the
    // quick settings menu stays as it is.
    _hideSystemBattery() {
        const sys = Main.panel.statusArea.quickSettings?._system;
        if (!sys) {
            // Quick settings builds its indicators asynchronously at login.
            this._hideRetryId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 250, () => {
                this._hideRetryId = 0;
                this._hideSystemBattery();
                return GLib.SOURCE_REMOVE;
            });
            return;
        }
        this._systemBattery = sys;
        sys.hide();
        // GNOME shows it again whenever its icon changes, so keep it hidden.
        sys.connectObject('notify::visible', () => {
            if (sys.visible)
                sys.hide();
        }, this);
    }

    _restoreSystemBattery() {
        if (this._hideRetryId) {
            GLib.source_remove(this._hideRetryId);
            this._hideRetryId = 0;
        }
        const sys = this._systemBattery;
        if (!sys)
            return;
        sys.disconnectObject(this);
        sys._syncIndicatorsVisible?.();
        this._systemBattery = null;
    }
}
