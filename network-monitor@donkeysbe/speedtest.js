// Internet speed test against Measurement Lab (M-Lab) with the ndt7
// protocol: the same open test Google runs for "speed test" searches.
// https://github.com/m-lab/ndt-server/blob/main/spec/ndt7-protocol.md
//
// Only needs GLib/Gio/Soup, so it also runs outside GNOME Shell:
//   NMW_SPEEDTEST_CLI=1 gjs -m speedtest.js

import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import Soup from 'gi://Soup?version=3.0';

Gio._promisify(Soup.Session.prototype, 'send_and_read_async');
Gio._promisify(Soup.Session.prototype, 'websocket_connect_async');

const LOCATE_URL = 'https://locate.measurementlab.net/v2/nearest/ndt/ndt7';
const CLIENT = 'client_name=gnome-network-monitor&client_version=1';
const PROTOCOL = 'net.measurementlab.ndt.v7';
const PHASE_SECONDS = 10;     // ndt7 runs each direction for about 10 s
const PHASE_TIMEOUT = 15;     // give up on a phase that hangs
const PROGRESS_MS = 250;

const now = () => GLib.get_monotonic_time() / 1e6;
const mbps = (bytes, seconds) => (seconds > 0 ? bytes * 8 / seconds / 1e6 : 0);

function makeSession() {
    const session = new Soup.Session({timeout: PHASE_TIMEOUT});
    session.user_agent = 'gnome-network-monitor/1';
    return session;
}

async function locate(session, cancellable) {
    const msg = Soup.Message.new('GET', `${LOCATE_URL}?${CLIENT}`);
    const bytes = await session.send_and_read_async(msg, GLib.PRIORITY_DEFAULT, cancellable);
    if (msg.get_status() !== Soup.Status.OK)
        throw new Error(`M-Lab server lookup failed (HTTP ${msg.get_status()})`);
    const json = JSON.parse(new TextDecoder().decode(bytes.get_data()));
    const r = json.results?.[0];
    if (!r)
        throw new Error('M-Lab has no test server available right now');
    return {
        machine: r.machine,
        city: r.location?.city ?? '',
        country: r.location?.country ?? '',
        download: r.urls['wss:///ndt/v7/download'],
        upload: r.urls['wss:///ndt/v7/upload'],
    };
}

async function connect(session, url, cancellable) {
    const msg = Soup.Message.new('GET', url);
    const ws = await session.websocket_connect_async(msg, null, [PROTOCOL], GLib.PRIORITY_DEFAULT, cancellable);
    ws.max_incoming_payload_size = 1 << 25; // ndt7 messages go up to 16 MiB
    ws.keepalive_interval = 0;
    return ws;
}

// Resolves when the socket closes, the phase times out or it's cancelled.
function runPhase(ws, cancellable, onTick, setup) {
    return new Promise((resolve, reject) => {
        const ids = [];
        let timerId = 0, cancelId = 0, done = false;
        const finish = err => {
            if (done)
                return;
            done = true;
            if (timerId)
                GLib.source_remove(timerId);
            if (cancelId)
                cancellable?.disconnect(cancelId);
            ids.forEach(id => ws.disconnect(id));
            if (ws.get_state() === Soup.WebsocketState.OPEN)
                ws.close(Soup.WebsocketCloseCode.NORMAL, null);
            err ? reject(err) : resolve();
        };
        ids.push(ws.connect('closed', () => finish()));
        ids.push(ws.connect('error', (_ws, e) => finish(e)));
        const stop = setup(ids, () => finish());
        const start = now();
        timerId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, PROGRESS_MS, () => {
            onTick();
            if (now() - start > PHASE_TIMEOUT) {
                timerId = 0;
                finish();
                return GLib.SOURCE_REMOVE;
            }
            stop?.();
            return GLib.SOURCE_CONTINUE;
        });
        // Finish from an idle callback: disconnecting a GCancellable handler
        // from inside that handler deadlocks.
        if (cancellable) {
            cancelId = cancellable.connect(() => GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
                finish(new GLib.Error(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED, 'Cancelled'));
                return GLib.SOURCE_REMOVE;
            }));
        }
    });
}

// Download: the server sends data for ~10 s; we count what arrives.
// Its periodic text messages carry TCP info, including the minimum RTT.
async function download(session, url, cancellable, onProgress) {
    const ws = await connect(session, url, cancellable);
    let bytes = 0, minRtt = null;
    const start = now();
    await runPhase(ws, cancellable,
        () => onProgress(mbps(bytes, now() - start), (now() - start) / PHASE_SECONDS,
            minRtt !== null ? minRtt / 1000 : null),
        ids => {
            ids.push(ws.connect('message', (_ws, type, data) => {
                bytes += data.get_size();
                if (type !== Soup.WebsocketDataType.TEXT)
                    return;
                try {
                    const m = JSON.parse(new TextDecoder().decode(data.get_data()));
                    const rtt = m.TCPInfo?.MinRTT;
                    if (rtt > 0)
                        minRtt = minRtt === null ? rtt : Math.min(minRtt, rtt);
                } catch {}
            }));
        });
    return {mbps: mbps(bytes, now() - start), ping: minRtt !== null ? minRtt / 1000 : null};
}

// Upload: we send for 10 s. Soup has no "buffered amount", so we keep only
// about half a second of data in flight beyond what the server says it has
// received; otherwise a slow uplink keeps sending a backlog after the 10 s.
// The result uses the server's byte count (TCPInfo.BytesReceived).
async function upload(session, url, cancellable, onProgress) {
    const ws = await connect(session, url, cancellable);
    const chunk = new GLib.Bytes(new Uint8Array(1 << 18).map(() => Math.random() * 256));
    let sent = 0, received = 0, receivedAt = 0;
    const start = now();
    const rate = () => mbps(received, receivedAt);
    const window = () => Math.min(64 << 20, Math.max(1 << 20, rate() * 1e6 / 8 / 2));
    await runPhase(ws, cancellable,
        () => onProgress(rate(), (now() - start) / PHASE_SECONDS),
        (ids, done) => {
            const pump = () => {
                if (now() - start >= PHASE_SECONDS) {
                    done();
                    return;
                }
                while (ws.get_state() === Soup.WebsocketState.OPEN && sent - received < window()) {
                    ws.send_message(Soup.WebsocketDataType.BINARY, chunk);
                    sent += chunk.get_size();
                }
            };
            ids.push(ws.connect('message', (_ws, type, data) => {
                if (type !== Soup.WebsocketDataType.TEXT)
                    return;
                try {
                    const m = JSON.parse(new TextDecoder().decode(data.get_data()));
                    const r = Math.max(m.TCPInfo?.BytesReceived ?? 0, m.AppInfo?.NumBytes ?? 0);
                    if (r > received) {
                        received = r;
                        receivedAt = now() - start;
                    }
                } catch {}
                pump();
            }));
            pump();
            return pump;
        });
    return {mbps: rate()};
}

/**
 * Runs a full test. onProgress({phase, mbps, fraction, server, ping}) is called
 * a few times a second; phase is 'locating', 'download' or 'upload'.
 * Resolves to {server, download, upload, ping, at} (speeds in Mb/s, ping in ms).
 */
export async function runSpeedTest({onProgress = () => {}, cancellable = null} = {}) {
    const session = makeSession();
    try {
        onProgress({phase: 'locating', mbps: 0, fraction: 0, server: null});
        const server = await locate(session, cancellable);
        const down = await download(session, server.download, cancellable,
            (v, f, ping) => onProgress({phase: 'download', mbps: v, fraction: Math.min(1, f), server, ping}));
        const up = await upload(session, server.upload, cancellable,
            (v, f) => onProgress({phase: 'upload', mbps: v, fraction: Math.min(1, f), server}));
        return {server, download: down.mbps, upload: up.mbps, ping: down.ping, at: GLib.DateTime.new_now_local()};
    } finally {
        session.abort();
    }
}

// `NMW_SPEEDTEST_CLI=1 gjs -m speedtest.js` runs a test from the terminal.
// (NMW_SPEEDTEST_CLI=1 keeps it from running when GNOME Shell imports this file.)
if (GLib.getenv('NMW_SPEEDTEST_CLI')) {
    const loop = new GLib.MainLoop(null, false);
    runSpeedTest({
        onProgress: p => printerr(`${p.phase.padEnd(9)} ${p.mbps.toFixed(1).padStart(7)} Mb/s  ${p.server?.city ?? ''}`),
    }).then(r => {
        print(JSON.stringify({...r, at: r.at.format_iso8601()}, null, 1));
    }).catch(e => printerr(`failed: ${e.message}`)).finally(() => loop.quit());
    loop.run();
}
