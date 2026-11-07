// Readers for CPU, memory, disks, temperatures, GPUs and processes, from
// /proc and /sys. Only needs GLib/Gio, so it also runs outside GNOME Shell:
//   SRW_CLI=1 gjs -m sysinfo.js

import GLib from 'gi://GLib';
import Gio from 'gi://Gio';

Gio._promisify(Gio.File.prototype, 'load_contents_async');
Gio._promisify(Gio.File.prototype, 'query_filesystem_info_async');
Gio._promisify(Gio.Subprocess.prototype, 'communicate_utf8_async');

const CLK_TCK = 100;      // USER_HZ on every Linux architecture GNOME runs on
const SECTOR = 512;       // /proc/diskstats always counts 512-byte sectors
const PAGE = 4096;
const DISK_RE = /^(nvme\d+n\d+|sd[a-z]+|vd[a-z]+|mmcblk\d+|hd[a-z]+)$/;
const SKIP_MOUNTS = /^\/(boot|efi|snap|var\/snap|run|sys|proc|dev)(\/|$)/;

const now = () => GLib.get_monotonic_time() / 1e6;

async function readText(path) {
    try {
        const [bytes] = await Gio.File.new_for_path(path).load_contents_async(null);
        return new TextDecoder().decode(bytes);
    } catch {
        return null;
    }
}

function readTextSync(path) {
    try {
        const [, bytes] = GLib.file_get_contents(path);
        return new TextDecoder().decode(bytes);
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

const num = t => (t === null || t === undefined || t.trim() === '' ? null : Number(t.trim()));

async function runOut(argv) {
    try {
        const proc = Gio.Subprocess.new(argv, Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_SILENCE);
        const [out] = await proc.communicate_utf8_async(null, null);
        return proc.get_successful() ? out : null;
    } catch {
        return null;
    }
}

// ---------- things that don't change while running ----------

function cpuModel() {
    const info = readTextSync('/proc/cpuinfo') ?? '';
    const m = /^model name\s*:\s*(.+)$/m.exec(info) ?? /^Hardware\s*:\s*(.+)$/m.exec(info);
    if (!m)
        return 'Processor';
    // "AMD Ryzen 7 5800H with Radeon Graphics" -> "Ryzen 7 5800H"
    return m[1]
        .replace(/\(R\)|\(TM\)|\bCPU\b|\bProcessor\b|with Radeon.*$|@.*$|\d+(th|st|nd|rd) Gen\b/gi, '')
        .replace(/^(AMD|Intel)\s+/i, '')
        .replace(/\s+/g, ' ')
        .trim();
}

function diskModel(dev) {
    const m = readTextSync(`/sys/block/${dev}/device/model`);
    return m ? m.trim().replace(/\s+/g, ' ') : null;
}

// GPUs from /sys/class/drm. The NVIDIA name comes from the driver's /proc
// file, which (unlike nvidia-smi) doesn't wake a sleeping GPU.
function findGpus() {
    const gpus = [];
    for (const card of listDir('/sys/class/drm').filter(n => /^card\d+$/.test(n)).sort()) {
        const dev = `/sys/class/drm/${card}/device`;
        const vendor = (readTextSync(`${dev}/vendor`) ?? '').trim();
        const integrated = (readTextSync(`${dev}/boot_vga`) ?? '').trim() === '1';
        let name, kind;
        if (vendor === '0x1002') {
            kind = 'amd';
            name = integrated ? 'Radeon Graphics' : 'AMD Radeon';
        } else if (vendor === '0x10de') {
            kind = 'nvidia';
            name = 'NVIDIA';
            for (const id of listDir('/proc/driver/nvidia/gpus')) {
                const m = /^Model:\s*(.+)$/m.exec(readTextSync(`/proc/driver/nvidia/gpus/${id}/information`) ?? '');
                if (m)
                    name = m[1].trim().replace(/^NVIDIA\s+/, '').replace(/\s+Laptop GPU$/, '');
            }
        } else if (vendor === '0x8086') {
            kind = 'intel';
            name = 'Intel Graphics';
        } else {
            continue;
        }
        const hwmon = listDir(`${dev}/hwmon`)[0];
        gpus.push({card, dev, kind, name, integrated, hwmon: hwmon ? `${dev}/hwmon/${hwmon}` : null});
    }
    return gpus;
}

// Which hwmon sensor is which. Returns [{key, label, path}].
function findTemps() {
    const out = [];
    const add = (key, label, path) => {
        if (!out.some(t => t.key === key))
            out.push({key, label, path});
    };
    for (const h of listDir('/sys/class/hwmon')) {
        const dir = `/sys/class/hwmon/${h}`;
        const name = (readTextSync(`${dir}/name`) ?? '').trim();
        const inputs = listDir(dir).filter(f => /^temp\d+_input$/.test(f)).sort();
        const labelOf = f => (readTextSync(`${dir}/${f.replace('_input', '_label')}`) ?? '').trim();
        const pick = re => inputs.find(f => re.test(labelOf(f))) ?? inputs[0];
        if (!inputs.length)
            continue;
        if (name === 'k10temp' || name === 'zenpower')
            add('cpu', 'CPU', `${dir}/${pick(/Tdie|Tctl/)}`);
        else if (name === 'coretemp')
            add('cpu', 'CPU', `${dir}/${pick(/Package/)}`);
        else if (name === 'cpu_thermal' || name === 'soc_thermal')
            add('cpu', 'CPU', `${dir}/${inputs[0]}`);
        else if (name === 'amdgpu' || name === 'radeon')
            add(`gpu-${h}`, 'GPU', `${dir}/${pick(/edge/)}`);
        else if (name === 'nvme')
            add(`ssd-${h}`, 'SSD', `${dir}/${pick(/Composite/)}`);
        else if (name === 'drivetemp')
            add(`disk-${h}`, 'Disk', `${dir}/${inputs[0]}`);
        else if (/^(iwlwifi|mt79|mt76|ath1|rtw)/.test(name))
            add('wifi', 'Wi-Fi', `${dir}/${inputs[0]}`);
    }
    // Laptops without a CPU driver sensor: fall back to the ACPI zone.
    if (!out.some(t => t.key === 'cpu')) {
        for (const z of listDir('/sys/class/thermal').filter(n => n.startsWith('thermal_zone'))) {
            const type = (readTextSync(`/sys/class/thermal/${z}/type`) ?? '').trim();
            if (/x86_pkg_temp|cpu|acpitz/i.test(type)) {
                out.unshift({key: 'cpu', label: 'CPU', path: `/sys/class/thermal/${z}/temp`});
                break;
            }
        }
    }
    const rank = t => ['cpu', 'gpu', 'ssd', 'disk', 'wifi'].findIndex(k => t.key.startsWith(k));
    return out.sort((a, b) => rank(a) - rank(b));
}

function findFans() {
    const fans = [];
    for (const h of listDir('/sys/class/hwmon')) {
        const dir = `/sys/class/hwmon/${h}`;
        for (const f of listDir(dir).filter(n => /^fan\d+_input$/.test(n)))
            fans.push(`${dir}/${f}`);
    }
    return fans;
}

function findMounts() {
    const seen = new Set();
    const mounts = [];
    for (const line of (readTextSync('/proc/mounts') ?? '').split('\n')) {
        const [dev, mount, type] = line.split(' ');
        if (!dev?.startsWith('/dev/') || dev.startsWith('/dev/loop') || SKIP_MOUNTS.test(mount ?? ''))
            continue;
        if (['vfat', 'squashfs', 'iso9660'].includes(type) || seen.has(dev))
            continue;
        seen.add(dev);
        mounts.push({dev, mount: mount.replace(/\\040/g, ' ')});
    }
    // "/" first, then the rest by path
    return mounts.sort((a, b) => (a.mount === '/' ? -1 : b.mount === '/' ? 1 : a.mount.localeCompare(b.mount)));
}

// ---------- sampler ----------

export class Sampler {
    constructor() {
        this.model = cpuModel();
        this.gpus = findGpus();
        this.temps = findTemps();
        this.fans = findFans();
        this.mounts = findMounts();
        const root = this.mounts.find(m => m.mount === '/');
        const rootDisk = root && /^\/dev\/(nvme\d+n\d+|mmcblk\d+|[a-z]+)/.exec(root.dev)?.[1];
        this.rootDiskModel = rootDisk ? diskModel(rootDisk) : null;
        this._prev = {};
    }

    // `detailed` adds disks, GPUs and processes; used while the popup is open.
    async read(detailed = false) {
        const t = now();
        const [stat, meminfo, loadavg, uptime, diskstats] = await Promise.all([
            readText('/proc/stat'), readText('/proc/meminfo'), readText('/proc/loadavg'),
            readText('/proc/uptime'), readText('/proc/diskstats'),
        ]);
        const s = {
            model: this.model,
            cpu: this._cpu(stat ?? ''),
            mem: this._mem(meminfo ?? ''),
            io: this._io(diskstats ?? '', t),
            temps: await this._temps(),
            fans: (await Promise.all(this.fans.map(f => readText(f)))).map(num).filter(v => v !== null),
            load: (loadavg ?? '0 0 0').split(' ').slice(0, 3).map(Number),
            procs: Number(/(\d+)\/(\d+)/.exec(loadavg ?? '')?.[2] ?? 0),
            uptime: Number((uptime ?? '0').split(' ')[0]),
        };
        s.cpu.freq = await this._freq(s.cpu.perCore.length);
        s.power = await this._power();
        if (detailed) {
            const [disks, gpus, top] = await Promise.all([this._disks(), this._gpus(), this._processes(t)]);
            Object.assign(s, {disks, gpus, top});
        }
        return s;
    }

    _cpu(stat) {
        const lines = stat.split('\n').filter(l => /^cpu\d* /.test(l));
        const usage = line => {
            const v = line.trim().split(/\s+/).slice(1, 9).map(Number);
            const idle = v[3] + (v[4] ?? 0);
            const total = v.reduce((a, b) => a + b, 0);
            return {idle, total};
        };
        const cur = lines.map(usage);
        const prev = this._prev.cpu;
        this._prev.cpu = cur;
        const pct = (c, p) => (p && c.total > p.total ? 100 * (1 - (c.idle - p.idle) / (c.total - p.total)) : 0);
        return {
            usage: pct(cur[0], prev?.[0]),
            perCore: cur.slice(1).map((c, i) => pct(c, prev?.[i + 1])),
            ready: !!prev,
        };
    }

    async _freq(n) {
        const vals = (await Promise.all([...Array(n).keys()].map(i =>
            readText(`/sys/devices/system/cpu/cpu${i}/cpufreq/scaling_cur_freq`)))).map(num).filter(v => v);
        if (!vals.length)
            return null;
        return {avg: vals.reduce((a, b) => a + b, 0) / vals.length / 1000, max: Math.max(...vals) / 1000}; // MHz
    }

    _mem(meminfo) {
        const kb = k => Number(new RegExp(`^${k}:\\s+(\\d+)`, 'm').exec(meminfo)?.[1] ?? 0) * 1024;
        const total = kb('MemTotal');
        const available = kb('MemAvailable');
        return {
            total, available, used: total - available,
            cache: kb('Cached') + kb('Buffers') - kb('Shmem'),
            swapTotal: kb('SwapTotal'), swapUsed: kb('SwapTotal') - kb('SwapFree'),
        };
    }

    _io(diskstats, t) {
        let read = 0, write = 0;
        for (const line of diskstats.split('\n')) {
            const f = line.trim().split(/\s+/);
            if (DISK_RE.test(f[2] ?? '')) {
                read += Number(f[5]) * SECTOR;
                write += Number(f[9]) * SECTOR;
            }
        }
        const prev = this._prev.io;
        this._prev.io = {read, write, t};
        if (!prev || t - prev.t < 0.2)
            return {read: 0, write: 0};
        return {read: Math.max(0, read - prev.read) / (t - prev.t), write: Math.max(0, write - prev.write) / (t - prev.t)};
    }

    async _temps() {
        const vals = await Promise.all(this.temps.map(async s => {
            const v = num(await readText(s.path));
            return v !== null && v > 0 ? {key: s.key, label: s.label, c: v / 1000} : null;
        }));
        return vals.filter(Boolean);
    }

    // AMD APUs report the whole package (CPU + GPU) as the iGPU's PPT.
    async _power() {
        const igpu = this.gpus.find(g => g.kind === 'amd' && g.integrated && g.hwmon);
        if (!igpu)
            return null;
        const v = num(await readText(`${igpu.hwmon}/power1_input`)) ?? num(await readText(`${igpu.hwmon}/power1_average`));
        return v !== null ? {watts: v / 1e6, label: 'processor package'} : null;
    }

    async _disks() {
        return (await Promise.all(this.mounts.map(async m => {
            try {
                const info = await Gio.File.new_for_path(m.mount).query_filesystem_info_async(
                    'filesystem::size,filesystem::free', GLib.PRIORITY_DEFAULT, null);
                const size = info.get_attribute_uint64('filesystem::size');
                const free = info.get_attribute_uint64('filesystem::free');
                return size > 0 ? {...m, size, free} : null;
            } catch {
                return null;
            }
        }))).filter(Boolean);
    }

    // A sleeping NVIDIA GPU is reported as sleeping, never woken up:
    // nvidia-smi only runs while it's already awake.
    async _gpus() {
        return Promise.all(this.gpus.map(async g => {
            const status = (await readText(`${g.dev}/power/runtime_status`))?.trim() ?? 'active';
            const r = {name: g.name, kind: g.kind, integrated: g.integrated, asleep: status === 'suspended'};
            if (r.asleep)
                return r;
            if (g.kind === 'amd') {
                r.busy = num(await readText(`${g.dev}/gpu_busy_percent`));
                r.memUsed = num(await readText(`${g.dev}/mem_info_vram_used`));
                r.memTotal = num(await readText(`${g.dev}/mem_info_vram_total`));
            } else if (g.kind === 'nvidia' && GLib.find_program_in_path('nvidia-smi')) {
                const out = await runOut(['nvidia-smi', '--query-gpu=utilization.gpu,temperature.gpu,power.draw,memory.used,memory.total',
                    '--format=csv,noheader,nounits']);
                const [busy, temp, power, used, total] = (out ?? '').split(',').map(v => Number(v.trim()));
                if (out) {
                    Object.assign(r, {busy, temp, power: Number.isNaN(power) ? null : power,
                        memUsed: used * 1048576, memTotal: total * 1048576});
                }
            }
            return r;
        }));
    }

    // Top processes by CPU, grouped by name (a browser's many processes
    // count as one). CPU is a share of the whole processor, like the hero.
    async _processes(t) {
        const pids = listDir('/proc').filter(n => /^\d+$/.test(n));
        const stats = await Promise.all(pids.map(async pid => [pid, await readText(`/proc/${pid}/stat`)]));
        const cur = new Map();
        const groups = new Map();
        const prev = this._prev.procs;
        const cores = this._prev.cpu ? this._prev.cpu.length - 1 : 1;
        for (const [pid, text] of stats) {
            if (!text)
                continue;
            const close = text.lastIndexOf(')');
            const name = text.slice(text.indexOf('(') + 1, close);
            const f = text.slice(close + 2).split(' ');
            const ticks = Number(f[11]) + Number(f[12]);
            const rss = Number(f[21]) * PAGE;
            cur.set(pid, ticks);
            if (rss === 0)
                continue; // kernel threads
            const dt = prev ? t - prev.t : 0;
            const before = prev?.ticks.get(pid);
            const cpu = dt > 0 && before !== undefined ? Math.max(0, ticks - before) / CLK_TCK / dt * 100 / cores : 0;
            const g = groups.get(name) ?? {name, cpu: 0, mem: 0, count: 0};
            g.cpu += cpu;
            g.mem += rss;
            g.count++;
            groups.set(name, g);
        }
        this._prev.procs = {t, ticks: cur};
        if (!prev)
            return null;
        return [...groups.values()].sort((a, b) => b.cpu - a.cpu || b.mem - a.mem).slice(0, 4);
    }
}

// `SRW_CLI=1 gjs -m sysinfo.js` prints two samples.
if (GLib.getenv('SRW_CLI')) {
    const loop = new GLib.MainLoop(null, false);
    const s = new Sampler();
    print(JSON.stringify({model: s.model, gpus: s.gpus, temps: s.temps, fans: s.fans, mounts: s.mounts, disk: s.rootDiskModel}, null, 1));
    s.read(true).then(() => GLib.timeout_add(0, 1500, () => {
        s.read(true).then(r => print(JSON.stringify(r, null, 1))).catch(e => printerr(e.stack)).finally(() => loop.quit());
        return GLib.SOURCE_REMOVE;
    }));
    loop.run();
}
