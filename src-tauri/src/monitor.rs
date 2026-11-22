//! Machine resource monitor: the local machine (sysinfo) or the remote Linux host of
//! an SSH session (a read-only script over an exec channel on the same connection).

use std::collections::HashMap;
use std::sync::LazyLock;
use std::time::Instant;

use parking_lot::Mutex;
use serde::Serialize;
use sysinfo::{Disks, Gpus, Networks, ProcessRefreshKind, ProcessesToUpdate, System, UpdateKind};

use crate::session::Sessions;

#[derive(Serialize, Default, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    pub host: String,
    pub os: String,
    pub uptime: u64,
    pub cpu_name: String,
    pub cpu: f32,
    pub cores: Vec<f32>,
    pub load: Option<[f64; 3]>,
    pub mem_used: u64,
    pub mem_total: u64,
    pub swap_used: u64,
    pub swap_total: u64,
    pub disks: Vec<Disk>,
    pub net_rx: f64, // bytes/s
    pub net_tx: f64,
    pub procs: Vec<Proc>,
    pub gpus: Vec<Gpu>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Disk {
    pub mount: String,
    pub device: String,
    pub fs: String,
    pub kind: String, // "SSD" | "HDD" | ""
    pub removable: bool,
    pub used: u64,
    pub avail: u64,
    pub total: u64,
    pub read_rate: f64, // bytes/s
    pub write_rate: f64,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Proc {
    pub pid: u32,
    pub name: String,
    pub cpu: f32,
    pub mem: u64,
    pub gpu: Option<f32>,
    pub gpu_mem: Option<u64>,
    pub user: String,
    pub cmd: String,
    pub exe: Option<String>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Gpu {
    /// "gpu", or "npu" for Huawei Ascend accelerators (read from npu-smi).
    pub kind: &'static str,
    pub name: String,
    /// GPU utilisation; for an NPU, AI Core usage.
    pub util: Option<f32>,
    pub mem_used: Option<u64>,
    pub mem_total: Option<u64>,
    pub temp: Option<f32>,
    /// Watts, when reported.
    pub power: Option<f32>,
    /// npu-smi health ("OK", "Warning", "Alarm", "Critical"…).
    pub health: Option<String>,
}

// ------------------------------------------------------------------ local

struct Local {
    sys: System,
    disks: Option<Disks>,
    nets: Option<Networks>,
    gpus: Option<Gpus>,
    last_net: Instant,
    nvidia_smi: Option<bool>,
    npu_smi: Option<bool>,
}

/// The sampler lives on one dedicated thread: CPU usage needs consecutive samples
/// from the same `System`, and some platform GPU handles aren't `Send`.
static WORKER: LazyLock<Mutex<std::sync::mpsc::Sender<std::sync::mpsc::Sender<Snapshot>>>> =
    LazyLock::new(|| {
        let (tx, rx) = std::sync::mpsc::channel::<std::sync::mpsc::Sender<Snapshot>>();
        std::thread::Builder::new()
            .name("monitor".into())
            .spawn(move || {
                let Ok(mut sys) = System::new() else { return };
                sys.refresh_cpu_usage();
                let mut l = Local {
                    sys,
                    disks: Disks::new_with_refreshed_list().ok(),
                    nets: Networks::new_with_refreshed_list().ok(),
                    gpus: Gpus::new_with_refreshed_list().ok(),
                    last_net: Instant::now(),
                    nvidia_smi: None,
                    // Ascend cards only exist on Linux hosts.
                    npu_smi: if cfg!(target_os = "linux") { None } else { Some(false) },
                };
                while let Ok(reply) = rx.recv() {
                    let _ = reply.send(sample(&mut l));
                }
            })
            .expect("monitor thread");
        Mutex::new(tx)
    });

pub fn local() -> Snapshot {
    let (tx, rx) = std::sync::mpsc::channel();
    if WORKER.lock().send(tx).is_err() {
        return Snapshot::default();
    }
    rx.recv().unwrap_or_default()
}

fn sample(l: &mut Local) -> Snapshot {
    l.sys.refresh_cpu_usage();
    l.sys.refresh_memory();
    l.sys.refresh_processes_specifics(
        ProcessesToUpdate::All,
        true,
        ProcessRefreshKind::nothing()
            .with_cpu()
            .with_memory()
            .with_exe(UpdateKind::OnlyIfNotSet)
            .with_cmd(UpdateKind::OnlyIfNotSet)
            .with_gpu_usage()
            .with_gpu_memory(),
    );
    if let Some(d) = l.disks.as_mut() {
        d.refresh(true);
    }
    if let Some(n) = l.nets.as_mut() {
        n.refresh(true);
    }
    let dt = l.last_net.elapsed().as_secs_f64().max(0.001);
    l.last_net = Instant::now();

    let cores: Vec<f32> = l.sys.cpus().iter().map(|c| c.usage()).collect();
    let ncpu = cores.len().max(1) as f32;
    let mut procs: Vec<Proc> = l
        .sys
        .processes()
        .iter()
        .map(|(pid, p)| Proc {
            pid: pid.as_u32(),
            name: p.name().to_string_lossy().into_owned(),
            // sysinfo reports per-core %, normalise to whole-machine %
            cpu: p.cpu_usage() / ncpu,
            mem: p.memory(),
            gpu: p.gpu_usage().filter(|g| *g > 0.0),
            gpu_mem: p.gpu_memory().filter(|m| *m > 0),
            user: String::new(),
            cmd: p
                .cmd()
                .iter()
                .map(|a| a.to_string_lossy())
                .collect::<Vec<_>>()
                .join(" ")
                .chars()
                .take(300)
                .collect(),
            exe: p.exe().map(|e| e.display().to_string()),
        })
        .collect();
    // All processes (a few hundred locally) so the filter can find any of them.
    procs.sort_by(|a, b| b.cpu.total_cmp(&a.cpu).then(b.mem.cmp(&a.mem)));

    let (mut rx, mut tx) = (0u64, 0u64);
    for (_, n) in l.nets.iter().flat_map(|n| n.iter()) {
        rx += n.received();
        tx += n.transmitted();
    }

    let mut seen = std::collections::HashSet::new();
    let disks = l
        .disks
        .iter()
        .flat_map(|d| d.iter())
        .filter(|d| d.total_space() > 0 && seen.insert(d.mount_point().to_path_buf()))
        .map(|d| {
            let io = d.usage();
            Disk {
                mount: d.mount_point().display().to_string(),
                device: d.name().to_string_lossy().into_owned(),
                fs: d.file_system().to_string_lossy().into_owned(),
                kind: match d.kind() {
                    sysinfo::DiskKind::SSD => "SSD".into(),
                    sysinfo::DiskKind::HDD => "HDD".into(),
                    _ => String::new(),
                },
                removable: d.is_removable(),
                used: d.total_space().saturating_sub(d.available_space()),
                avail: d.available_space(),
                total: d.total_space(),
                read_rate: io.read_bytes as f64 / dt,
                write_rate: io.written_bytes as f64 / dt,
            }
        })
        .collect();

    let mut gpus = Vec::new();
    if l.nvidia_smi != Some(false) {
        match nvidia_smi() {
            Some(g) => {
                l.nvidia_smi = Some(true);
                gpus = g;
            }
            None => l.nvidia_smi = Some(false),
        }
    }
    if l.npu_smi != Some(false) {
        match npu_smi() {
            Some(n) => {
                l.npu_smi = Some(true);
                gpus.extend(n);
            }
            None => l.npu_smi = Some(false),
        }
    }
    if gpus.is_empty() {
        if let Some(g) = l.gpus.as_mut() {
            g.refresh(true);
            gpus = g
                .iter()
                .map(|g| Gpu {
                    kind: "gpu",
                    name: g.model().or(g.vendor()).unwrap_or("GPU").to_string(),
                    util: g.usage(),
                    mem_used: g.used_memory(),
                    mem_total: g.total_memory(),
                    temp: None,
                    power: None,
                    health: None,
                })
                .collect();
        }
    }

    let load = System::load_average().ok();
    Snapshot {
        host: System::host_name().unwrap_or_default(),
        os: System::long_os_version().unwrap_or_default(),
        uptime: System::uptime().unwrap_or(0),
        cpu_name: l.sys.cpus().first().map(|c| c.brand().trim().to_string()).unwrap_or_default(),
        cpu: l.sys.global_cpu_usage(),
        cores,
        load: load.filter(|l| l.one > 0.0).map(|l| [l.one, l.five, l.fifteen]),
        mem_used: l.sys.used_memory(),
        mem_total: l.sys.total_memory(),
        swap_used: l.sys.used_swap(),
        swap_total: l.sys.total_swap(),
        disks,
        net_rx: rx as f64 / dt,
        net_tx: tx as f64 / dt,
        procs,
        gpus,
    }
}

fn nvidia_smi() -> Option<Vec<Gpu>> {
    let mut cmd = std::process::Command::new("nvidia-smi");
    cmd.args([
        "--query-gpu=name,utilization.gpu,memory.used,memory.total,temperature.gpu",
        "--format=csv,noheader,nounits",
    ]);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    let out = cmd.output().ok()?;
    if !out.status.success() {
        return None;
    }
    let gpus = parse_nvidia(&String::from_utf8_lossy(&out.stdout));
    (!gpus.is_empty()).then_some(gpus)
}

fn parse_nvidia(text: &str) -> Vec<Gpu> {
    text.lines()
        .filter_map(|l| {
            let f: Vec<&str> = l.split(',').map(str::trim).collect();
            (f.len() >= 5).then(|| Gpu {
                kind: "gpu",
                name: f[0].to_string(),
                util: f[1].parse().ok(),
                mem_used: f[2].parse::<u64>().ok().map(|m| m * 1024 * 1024),
                mem_total: f[3].parse::<u64>().ok().map(|m| m * 1024 * 1024),
                temp: f[4].parse().ok(),
                power: f.get(5).and_then(|p| p.parse().ok()),
                health: None,
            })
        })
        .collect()
}

// ------------------------------------------------------------------ Ascend NPU (npu-smi)

fn npu_smi() -> Option<Vec<Gpu>> {
    for bin in ["npu-smi", "/usr/local/sbin/npu-smi", "/usr/local/bin/npu-smi"] {
        if let Ok(out) = std::process::Command::new(bin).arg("info").output() {
            if out.status.success() {
                let n = parse_npu(&String::from_utf8_lossy(&out.stdout));
                return (!n.devices.is_empty()).then_some(n.devices);
            }
        }
    }
    None
}

#[derive(Default)]
struct NpuInfo {
    devices: Vec<Gpu>,
    /// pid -> device memory in bytes (process table).
    procs: HashMap<u32, u64>,
}

/// `npu-smi info` prints a box-drawn table, two rows per chip:
///
/// ```text
/// | NPU   Name         | Health   | Power(W)  Temp(C)   Hugepages-Usage(page) |
/// | Chip  [Device]     | Bus-Id   | AICore(%) Memory-Usage(MB) [HBM-Usage(MB)] |
/// | 0     910B3        | OK       | 93.6      40        0    / 0              |
/// | 0                  | 0000:C1:00.0 | 0     0    / 0   3161 / 65536         |
/// ```
///
/// then a process table (`NPU Chip | Process id | Process name | Process memory(MB)`).
/// Columns vary between driver versions and card families (310P has no HBM column,
/// several chips can follow one NPU row), so cells are recognised by shape, not position.
fn parse_npu(text: &str) -> NpuInfo {
    let mut info = NpuInfo::default();
    let mut in_procs = false;
    // Current NPU row: (id, model, health, power, temp) — chip rows below it belong to it.
    let mut npu: Option<(String, String, String, Option<f32>, Option<f32>)> = None;
    let mut chips_of_npu = 0usize;
    let num = |s: &str| s.trim().parse::<f32>().ok();
    let pairs = |s: &str| -> Vec<(u64, u64)> {
        // "0 / 0   3161 / 65536" -> [(0,0), (3161,65536)]
        let t: Vec<&str> = s.split_whitespace().collect();
        let mut out = Vec::new();
        let mut i = 0;
        while i + 2 < t.len() {
            if t[i + 1] == "/" {
                if let (Ok(a), Ok(b)) = (t[i].parse(), t[i + 2].parse()) {
                    out.push((a, b));
                    i += 3;
                    continue;
                }
            }
            i += 1;
        }
        out
    };
    for line in text.lines() {
        let line = line.trim();
        if !line.starts_with('|') {
            continue;
        }
        let cells: Vec<&str> = line.trim_matches('|').split('|').map(str::trim).collect();
        if line.contains("Process id") || line.contains("Process name") {
            in_procs = true;
            continue;
        }
        if in_procs {
            // | 0  0 | 12345 | python3 | 2048 |
            if cells.len() >= 4 {
                if let (Ok(pid), Some(mb)) = (cells[1].parse::<u32>(), num(cells[cells.len() - 1])) {
                    *info.procs.entry(pid).or_default() += mb as u64 * 1024 * 1024;
                }
            }
            continue;
        }
        if cells.len() < 3 {
            continue;
        }
        let first: Vec<&str> = cells[0].split_whitespace().collect();
        let is_bus = cells[1].len() >= 7 && cells[1].chars().nth(4) == Some(':') && cells[1].contains('.');
        if is_bus {
            // Chip row: AICore(%) then "used / total" pairs (Memory, then HBM if present).
            let Some((id, model, health, power, temp)) = npu.clone() else { continue };
            let usage = cells[2];
            let util = usage.split_whitespace().next().and_then(num);
            let p = pairs(usage);
            // HBM is the accelerator's real working memory where it exists (910 family).
            let mem = p.iter().rev().find(|(_, t)| *t > 0).copied();
            let chip = first.first().copied().unwrap_or("0");
            chips_of_npu += 1;
            let name = if chips_of_npu > 1 || chip != "0" {
                format!("Ascend {model} · NPU {id} chip {chip}")
            } else {
                format!("Ascend {model}")
            };
            info.devices.push(Gpu {
                kind: "npu",
                name,
                util,
                mem_used: mem.map(|m| m.0 * 1024 * 1024),
                mem_total: mem.map(|m| m.1 * 1024 * 1024),
                temp,
                power,
                health: Some(health),
            });
        } else if first.len() >= 2 && first[0].parse::<u32>().is_ok() && !cells[1].is_empty() && cells[1].chars().all(|c| c.is_ascii_alphabetic()) {
            // NPU row: id + model | health | power temp hugepages
            let mut t = cells[2].split_whitespace();
            let power = t.next().and_then(num);
            let temp = t.next().and_then(num);
            npu = Some((first[0].to_string(), first[1..].join(" "), cells[1].to_string(), power, temp));
            chips_of_npu = 0;
        }
    }
    info
}

// ------------------------------------------------------------------ remote (Linux over SSH)

const SCRIPT: &str = "export LC_ALL=C; \
echo '##host'; hostname; uname -sr; \
echo '##uptime'; cat /proc/uptime; \
echo '##stat'; grep '^cpu' /proc/stat; \
echo '##cpuinfo'; grep -m1 'model name' /proc/cpuinfo; \
echo '##mem'; cat /proc/meminfo; \
echo '##load'; cat /proc/loadavg; \
echo '##df'; (df -kPT -x tmpfs -x devtmpfs -x overlay -x squashfs -x efivarfs 2>/dev/null || df -kP); \
echo '##net'; cat /proc/net/dev; \
echo '##ps'; ps -eo pid,pcpu,rss,user:16,comm:24,args --sort=-pcpu 2>/dev/null | head -81; \
echo '##psmem'; ps -eo pid,pcpu,rss,user:16,comm:24,args --sort=-rss 2>/dev/null | head -61; \
echo '##gpuapps'; nvidia-smi --query-compute-apps=pid,used_memory --format=csv,noheader,nounits 2>/dev/null; \
echo '##diskstats'; cat /proc/diskstats; \
echo '##gpu'; nvidia-smi --query-gpu=name,utilization.gpu,memory.used,memory.total,temperature.gpu,power.draw --format=csv,noheader,nounits 2>/dev/null; \
echo '##npu'; for n in npu-smi /usr/local/sbin/npu-smi /usr/local/bin/npu-smi; do command -v $n >/dev/null 2>&1 && { $n info 2>/dev/null; break; }; done; \
echo '##end'";

#[derive(Default)]
struct Prev {
    cpu: Vec<(u64, u64)>, // (busy, total) per line: [0] = all, [1..] = cores
    net: (u64, u64),
    disk: HashMap<String, (u64, u64)>, // device -> (sectors read, sectors written)
    at: Option<Instant>,
}

static PREV: LazyLock<Mutex<HashMap<String, Prev>>> = LazyLock::new(Default::default);

pub async fn remote(sessions: &Sessions, session_id: &str) -> anyhow::Result<Snapshot> {
    let conn = sessions.ssh(session_id).map_err(anyhow::Error::msg)?;
    let out = conn.exec(SCRIPT).await?;
    if !out.contains("##stat\ncpu") {
        anyhow::bail!("resource monitoring needs a Linux host (/proc)");
    }
    let mut prev = PREV.lock();
    let p = prev.entry(session_id.to_string()).or_default();
    Ok(parse_remote(&out, p))
}

pub fn forget(session_id: &str) {
    PREV.lock().remove(session_id);
}

fn sections(text: &str) -> HashMap<&str, Vec<&str>> {
    let mut map: HashMap<&str, Vec<&str>> = HashMap::new();
    let mut cur = "";
    for line in text.lines() {
        if let Some(name) = line.strip_prefix("##") {
            cur = name;
            map.entry(cur).or_default();
        } else if !cur.is_empty() {
            map.entry(cur).or_default().push(line);
        }
    }
    map
}

fn parse_remote(text: &str, prev: &mut Prev) -> Snapshot {
    let s = sections(text);
    let get = |k: &str| s.get(k).cloned().unwrap_or_default();
    let mut snap = Snapshot::default();

    let host = get("host");
    snap.host = host.first().map(|x| x.trim().to_string()).unwrap_or_default();
    snap.os = host.get(1).map(|x| x.trim().to_string()).unwrap_or_default();
    snap.uptime = get("uptime")
        .first()
        .and_then(|l| l.split_whitespace().next())
        .and_then(|v| v.parse::<f64>().ok())
        .map(|v| v as u64)
        .unwrap_or(0);
    snap.cpu_name = get("cpuinfo")
        .first()
        .and_then(|l| l.split(':').nth(1))
        .map(|x| x.trim().to_string())
        .unwrap_or_default();

    // CPU: deltas of /proc/stat
    let now: Vec<(u64, u64)> = get("stat")
        .iter()
        .map(|l| {
            let v: Vec<u64> = l.split_whitespace().skip(1).filter_map(|x| x.parse().ok()).collect();
            let total: u64 = v.iter().take(8).sum();
            let idle = v.get(3).copied().unwrap_or(0) + v.get(4).copied().unwrap_or(0);
            (total - idle.min(total), total)
        })
        .collect();
    let pct = |i: usize| -> f32 {
        match (prev.cpu.get(i), now.get(i)) {
            (Some(&(b0, t0)), Some(&(b1, t1))) if t1 > t0 => ((b1 - b0) as f32 / (t1 - t0) as f32 * 100.0).clamp(0.0, 100.0),
            _ => 0.0,
        }
    };
    if !now.is_empty() {
        snap.cpu = pct(0);
        snap.cores = (1..now.len()).map(pct).collect();
    }
    prev.cpu = now;

    // Memory
    let mut mem: HashMap<&str, u64> = HashMap::new();
    for l in get("mem") {
        let mut it = l.split_whitespace();
        if let (Some(k), Some(v)) = (it.next(), it.next()) {
            if let Ok(v) = v.parse::<u64>() {
                mem.insert(k.trim_end_matches(':'), v * 1024);
            }
        }
    }
    snap.mem_total = mem.get("MemTotal").copied().unwrap_or(0);
    let avail = mem.get("MemAvailable").copied().unwrap_or(0);
    snap.mem_used = snap.mem_total.saturating_sub(avail);
    snap.swap_total = mem.get("SwapTotal").copied().unwrap_or(0);
    snap.swap_used = snap.swap_total.saturating_sub(mem.get("SwapFree").copied().unwrap_or(0));

    snap.load = get("load").first().and_then(|l| {
        let v: Vec<f64> = l.split_whitespace().take(3).filter_map(|x| x.parse().ok()).collect();
        (v.len() == 3).then(|| [v[0], v[1], v[2]])
    });

    // Disks (df -kPT: fs type in column 2; plain df -kP: no type column)
    for l in get("df").iter().skip(1) {
        let f: Vec<&str> = l.split_whitespace().collect();
        let (fs, total, used, avail, mount) = match f.len() {
            n if n >= 7 => (f[1], f[2], f[3], f[4], f[6..].join(" ")),
            6 => ("", f[1], f[2], f[3], f[5].to_string()),
            _ => continue,
        };
        if let (Ok(t), Ok(u), Ok(a)) = (total.parse::<u64>(), used.parse::<u64>(), avail.parse::<u64>()) {
            if t > 0 {
                snap.disks.push(Disk {
                    mount,
                    device: f[0].to_string(),
                    fs: fs.to_string(),
                    kind: String::new(),
                    removable: false,
                    used: u * 1024,
                    avail: a * 1024,
                    total: t * 1024,
                    read_rate: 0.0,
                    write_rate: 0.0,
                });
            }
        }
    }

    // Network: sum of non-loopback interfaces, rate from deltas
    let (mut rx, mut tx) = (0u64, 0u64);
    for l in get("net").iter().skip(2) {
        let Some((iface, rest)) = l.split_once(':') else { continue };
        if iface.trim() == "lo" {
            continue;
        }
        let v: Vec<u64> = rest.split_whitespace().filter_map(|x| x.parse().ok()).collect();
        if v.len() >= 9 {
            rx += v[0];
            tx += v[8];
        }
    }
    let dt = prev.at.map(|at| at.elapsed().as_secs_f64().max(0.001));
    if let Some(dt) = dt {
        snap.net_rx = rx.saturating_sub(prev.net.0) as f64 / dt;
        snap.net_tx = tx.saturating_sub(prev.net.1) as f64 / dt;
    }
    prev.net = (rx, tx);
    prev.at = Some(Instant::now());

    // Disk I/O from /proc/diskstats (sectors are 512 bytes).
    let mut disk_now: HashMap<String, (u64, u64)> = HashMap::new();
    for l in get("diskstats") {
        let f: Vec<&str> = l.split_whitespace().collect();
        if f.len() >= 10 {
            if let (Ok(r), Ok(w)) = (f[5].parse::<u64>(), f[9].parse::<u64>()) {
                disk_now.insert(f[2].to_string(), (r, w));
            }
        }
    }
    for d in &mut snap.disks {
        let dev = d.device.rsplit('/').next().unwrap_or("").to_string();
        if let (Some(dt), Some(&(r1, w1)), Some(&(r0, w0))) = (dt, disk_now.get(&dev), prev.disk.get(&dev)) {
            d.read_rate = r1.saturating_sub(r0) as f64 * 512.0 / dt;
            d.write_rate = w1.saturating_sub(w0) as f64 * 512.0 / dt;
        }
    }
    prev.disk = disk_now;

    // Processes (ps pcpu is per-core %, normalise). Top by CPU + top by memory.
    let ncpu = snap.cores.len().max(1) as f32;
    let npu = parse_npu(&get("npu").join("\n"));
    let mut gpu_mem: HashMap<u32, u64> = get("gpuapps")
        .iter()
        .filter_map(|l| {
            let mut it = l.split(',').map(str::trim);
            Some((it.next()?.parse().ok()?, it.next()?.parse::<u64>().ok()? * 1024 * 1024))
        })
        .collect();
    for (pid, m) in &npu.procs {
        *gpu_mem.entry(*pid).or_default() += m;
    }
    for l in get("ps").iter().skip(1).chain(get("psmem").iter().skip(1)) {
        let f: Vec<&str> = l.split_whitespace().collect();
        if f.len() < 5 {
            continue;
        }
        if let (Ok(pid), Ok(cpu), Ok(rss)) = (f[0].parse::<u32>(), f[1].parse::<f32>(), f[2].parse::<u64>()) {
            if snap.procs.iter().any(|p| p.pid == pid) {
                continue;
            }
            snap.procs.push(Proc {
                pid,
                name: f[4].to_string(),
                cpu: cpu / ncpu,
                mem: rss * 1024,
                gpu: None,
                gpu_mem: gpu_mem.get(&pid).copied(),
                user: f[3].to_string(),
                cmd: f[5..].join(" ").chars().take(300).collect(),
                exe: None,
            });
        }
    }

    snap.gpus = parse_nvidia(&get("gpu").join("\n"));
    snap.gpus.extend(npu.devices);
    snap
}

#[cfg(test)]
mod tests {
    use super::*;

    const SAMPLE: &str = "##host\nweb1\nLinux 6.1.0\n##uptime\n12345.6 999.0\n##stat\ncpu  100 0 100 800 0 0 0 0\ncpu0 50 0 50 400 0 0 0 0\n\
##cpuinfo\nmodel name\t: Intel Xeon\n##mem\nMemTotal: 1000 kB\nMemAvailable: 400 kB\nSwapTotal: 0 kB\nSwapFree: 0 kB\n\
##load\n0.50 0.40 0.30 1/100 1\n##df\nFilesystem Type 1024-blocks Used Available Capacity Mounted on\n/dev/sda1 ext4 1000 250 750 25% /\n\
##net\nh1\nh2\n  lo: 5 0 0 0 0 0 0 0 5 0 0 0 0 0 0 0\neth0: 1000 0 0 0 0 0 0 0 2000 0 0 0 0 0 0 0\n\
##ps\n  PID %CPU   RSS USER COMMAND ARGS\n  1  2.0  1024 root systemd /sbin/init splash\n##gpu\nTesla T4, 55, 1000, 15000, 60\n##end\n";

    const NPU_910B: &str = "\
+------------------------------------------------------------------------------------------------+
| npu-smi 24.1.0                   Version: 24.1.0                                               |
+---------------------------+---------------+----------------------------------------------------+
| NPU   Name                | Health        | Power(W)    Temp(C)           Hugepages-Usage(page)|
| Chip                      | Bus-Id        | AICore(%)   Memory-Usage(MB)  HBM-Usage(MB)        |
+===========================+===============+====================================================+
| 0     910B3               | OK            | 93.6        40                0    / 0             |
| 0                         | 0000:C1:00.0  | 12          0    / 0          3161 / 65536         |
+===========================+===============+====================================================+
| 1     910B3               | Warning       | 90.1        42                0    / 0             |
| 0                         | 0000:C2:00.0  | 0           0    / 0          3150 / 65536         |
+===========================+===============+====================================================+
+---------------------------+---------------+----------------------------------------------------+
| NPU     Chip              | Process id    | Process name             | Process memory(MB)      |
+===========================+===============+====================================================+
| 0       0                 | 4242          | python3                  | 2048                    |
+===========================+===============+====================================================+
| No running processes found in NPU 1                                                            |
+===========================+===============+====================================================+
";

    const NPU_310P: &str = "\
| npu-smi 24.1.rc2.3               Version: 24.1.rc2.3                                           |
| NPU     Name                | Health          | Power(W)     Temp(C)           Hugepages-Usage(page) |
| Chip    Device              | Bus-Id          | AICore(%)    Memory-Usage(MB)                        |
+=============================+=================+======================================================+
| 104     310P3               | OK              | NA           58                0     / 0             |
| 0       0                   | 0000:00:0D.0    | 0            1782 / 21527                            |
+=============================+=================+======================================================+
| 112     310P3               | OK              | NA           53                0     / 0             |
| 0       1                   | 0000:00:0E.0    | 3            1786 / 21527                            |
| 1       2                   | 0000:00:0F.0    | 5            100  / 21527                            |
+=============================+=================+======================================================+
";

    #[test]
    fn parses_npu_smi() {
        let a = parse_npu(NPU_910B);
        assert_eq!(a.devices.len(), 2);
        assert_eq!(a.devices[0].name, "Ascend 910B3");
        assert_eq!(a.devices[0].util, Some(12.0));
        assert_eq!(a.devices[0].mem_used, Some(3161 * 1024 * 1024));
        assert_eq!(a.devices[0].mem_total, Some(65536 * 1024 * 1024));
        assert_eq!(a.devices[0].power, Some(93.6));
        assert_eq!(a.devices[0].temp, Some(40.0));
        assert_eq!(a.devices[1].health.as_deref(), Some("Warning"));
        assert_eq!(a.procs.get(&4242), Some(&(2048 * 1024 * 1024)));

        let b = parse_npu(NPU_310P);
        assert_eq!(b.devices.len(), 3);
        assert_eq!(b.devices[0].name, "Ascend 310P3");
        assert_eq!(b.devices[0].power, None);
        assert_eq!(b.devices[0].mem_total, Some(21527 * 1024 * 1024));
        assert_eq!(b.devices[2].name, "Ascend 310P3 · NPU 112 chip 1");
        assert_eq!(b.devices[2].util, Some(5.0));
        assert!(parse_npu("command not found").devices.is_empty());
    }

    #[test]
    fn parses_proc_and_rates() {
        let mut prev = Prev::default();
        let a = parse_remote(SAMPLE, &mut prev);
        assert_eq!(a.host, "web1");
        assert_eq!(a.mem_total, 1000 * 1024);
        assert_eq!(a.mem_used, 600 * 1024);
        assert_eq!(a.disks[0].mount, "/");
        assert_eq!(a.disks[0].used, 250 * 1024);
        assert_eq!(a.gpus[0].name, "Tesla T4");
        assert_eq!(a.cpu, 0.0); // first sample has no delta
        let b = parse_remote(&SAMPLE.replace("cpu  100 0 100 800", "cpu  150 0 150 900"), &mut prev);
        assert!((b.cpu - 50.0).abs() < 0.01, "{}", b.cpu);
        assert_eq!(b.procs[0].name, "systemd");
    }
}

// ------------------------------------------------------------------ process actions

/// End a local process (`force` = kill immediately; otherwise ask it to terminate).
pub fn kill_local(pid: u32, force: bool) -> anyhow::Result<()> {
    let mut sys = System::new().map_err(|e| anyhow::anyhow!("{e:?}"))?;
    let p = sysinfo::Pid::from_u32(pid);
    sys.refresh_processes(ProcessesToUpdate::Some(&[p]), true);
    let proc_ = sys.process(p).ok_or_else(|| anyhow::anyhow!("process {pid} not found"))?;
    let ok = if force {
        proc_.kill()
    } else {
        proc_.kill_with(sysinfo::Signal::Term).unwrap_or_else(|| proc_.kill())
    };
    if !ok {
        anyhow::bail!("could not end process {pid} (permission denied?)");
    }
    Ok(())
}

/// End a process on the SSH host.
pub async fn kill_remote(sessions: &Sessions, session_id: &str, pid: u32, force: bool) -> anyhow::Result<()> {
    let conn = sessions.ssh(session_id).map_err(anyhow::Error::msg)?;
    let sig = if force { "KILL" } else { "TERM" };
    let out = conn.exec(&format!("kill -{sig} {pid} 2>&1 && echo __rt_ok")).await?;
    if !out.contains("__rt_ok") {
        anyhow::bail!("{}", out.trim());
    }
    Ok(())
}
