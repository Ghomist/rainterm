//! Serial port backend (COMx / /dev/ttyUSBx).

use std::io::{Read, Write};
use std::time::Duration;

use serde::{Deserialize, Serialize};

use super::{BackendIo, Ctrl, SessionEvent};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SerialTarget {
    pub port: String,
    pub baud: u32,
    #[serde(default = "eight")]
    pub data_bits: u8,
    #[serde(default)]
    pub parity: String, // "none" | "odd" | "even"
    #[serde(default = "one")]
    pub stop_bits: u8,
}

fn eight() -> u8 {
    8
}
fn one() -> u8 {
    1
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PortInfo {
    pub name: String,
    pub description: String,
}

pub fn list_ports() -> Vec<PortInfo> {
    serialport::available_ports()
        .unwrap_or_default()
        .into_iter()
        .map(|p| {
            let description = match p.port_type {
                serialport::SerialPortType::UsbPort(u) => {
                    u.product.or(u.manufacturer).unwrap_or_else(|| "USB".into())
                }
                serialport::SerialPortType::BluetoothPort => "Bluetooth".into(),
                serialport::SerialPortType::PciPort => "PCI".into(),
                serialport::SerialPortType::Unknown => String::new(),
            };
            PortInfo { name: p.port_name, description }
        })
        .collect()
}

pub fn spawn(target: SerialTarget, io: BackendIo) -> anyhow::Result<()> {
    let BackendIo { out, mut ctrl_rx, events, .. } = io;
    let port = serialport::new(&target.port, target.baud)
        .data_bits(match target.data_bits {
            5 => serialport::DataBits::Five,
            6 => serialport::DataBits::Six,
            7 => serialport::DataBits::Seven,
            _ => serialport::DataBits::Eight,
        })
        .parity(match target.parity.as_str() {
            "odd" => serialport::Parity::Odd,
            "even" => serialport::Parity::Even,
            _ => serialport::Parity::None,
        })
        .stop_bits(if target.stop_bits == 2 { serialport::StopBits::Two } else { serialport::StopBits::One })
        .timeout(Duration::from_millis(50))
        .open()?;
    let mut reader = port.try_clone()?;
    let mut writer = port;
    let _ = events.send(SessionEvent::Connected);

    let stop = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
    let stop_r = stop.clone();
    std::thread::Builder::new().name("serial-reader".into()).spawn(move || {
        let mut buf = vec![0u8; 16 * 1024];
        while !stop_r.load(std::sync::atomic::Ordering::Relaxed) {
            match reader.read(&mut buf) {
                Ok(0) => {}
                Ok(n) => {
                    if out.blocking_send(buf[..n].to_vec()).is_err() {
                        break;
                    }
                }
                Err(e) if e.kind() == std::io::ErrorKind::TimedOut => {}
                Err(_) => break,
            }
        }
    })?;

    std::thread::Builder::new().name("serial-ctrl".into()).spawn(move || {
        while let Some(msg) = ctrl_rx.blocking_recv() {
            match msg {
                Ctrl::Write(d) => {
                    if writer.write_all(&d).is_err() {
                        break;
                    }
                }
                Ctrl::Resize { .. } => {}
                Ctrl::Close | Ctrl::ChildExited => break,
            }
        }
        stop.store(true, std::sync::atomic::Ordering::Relaxed);
    })?;
    Ok(())
}
