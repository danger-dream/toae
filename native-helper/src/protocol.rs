use anyhow::{bail, Context, Result};
use serde_json::Value;
use std::io::{Read, Write};
use std::sync::Mutex;

pub const VERSION: u64 = 1;
pub const KIND_JSON: u8 = 1;
pub const KIND_BINARY: u8 = 2;
pub const MAX_JSON_FRAME: usize = 1024 * 1024;
pub const MAX_BINARY_FRAME: usize = 64 * 1024 * 1024;

#[derive(Debug)]
pub enum Frame {
    Json(Value),
    Binary { request_id: String, bytes: Vec<u8> },
}

pub struct FrameWriter<W: Write + Send> {
    inner: Mutex<W>,
}

impl<W: Write + Send> FrameWriter<W> {
    pub fn new(writer: W) -> Self {
        Self {
            inner: Mutex::new(writer),
        }
    }

    pub fn json(&self, value: &Value) -> Result<()> {
        let bytes = serde_json::to_vec(value).context("serialize protocol JSON")?;
        if bytes.len() > MAX_JSON_FRAME {
            bail!("JSON frame exceeds size limit");
        }
        self.write_payload(KIND_JSON, &bytes)
    }

    pub fn binary(&self, request_id: &str, bytes: &[u8]) -> Result<()> {
        if !(8..=128).contains(&request_id.len()) || bytes.len() > MAX_BINARY_FRAME {
            bail!("binary frame exceeds size limit");
        }
        let id_len = u16::try_from(request_id.len()).context("binary request id is too long")?;
        let mut payload = Vec::with_capacity(2 + request_id.len() + bytes.len());
        payload.extend_from_slice(&id_len.to_le_bytes());
        payload.extend_from_slice(request_id.as_bytes());
        payload.extend_from_slice(bytes);
        self.write_payload(KIND_BINARY, &payload)
    }

    fn write_payload(&self, kind: u8, bytes: &[u8]) -> Result<()> {
        let length = bytes
            .len()
            .checked_add(1)
            .and_then(|value| u32::try_from(value).ok())
            .context("protocol frame length overflow")?;
        let mut writer = self
            .inner
            .lock()
            .map_err(|_| anyhow::anyhow!("protocol writer lock poisoned"))?;
        writer.write_all(&length.to_le_bytes())?;
        writer.write_all(&[kind])?;
        writer.write_all(bytes)?;
        writer.flush()?;
        Ok(())
    }
}

pub fn read_frame<R: Read>(reader: &mut R) -> Result<Option<Frame>> {
    let mut length_bytes = [0_u8; 4];
    match reader.read_exact(&mut length_bytes) {
        Ok(()) => {}
        Err(error) if error.kind() == std::io::ErrorKind::UnexpectedEof => return Ok(None),
        Err(error) => return Err(error.into()),
    }
    let length = u32::from_le_bytes(length_bytes) as usize;
    if length < 1 || length > MAX_BINARY_FRAME + 131 {
        bail!("invalid protocol frame length");
    }
    let mut payload = vec![0_u8; length];
    reader.read_exact(&mut payload)?;
    match payload[0] {
        KIND_JSON => {
            if payload.len() - 1 > MAX_JSON_FRAME {
                bail!("JSON frame exceeds size limit");
            }
            let value = serde_json::from_slice(&payload[1..]).context("parse protocol JSON")?;
            Ok(Some(Frame::Json(value)))
        }
        KIND_BINARY => {
            if payload.len() < 3 {
                bail!("truncated binary frame");
            }
            let id_len = u16::from_le_bytes([payload[1], payload[2]]) as usize;
            if !(8..=128).contains(&id_len) || payload.len() < 3 + id_len {
                bail!("invalid binary request id");
            }
            let request_id = std::str::from_utf8(&payload[3..3 + id_len])?.to_owned();
            let bytes = payload[3 + id_len..].to_vec();
            if bytes.len() > MAX_BINARY_FRAME {
                bail!("binary frame exceeds size limit");
            }
            Ok(Some(Frame::Binary { request_id, bytes }))
        }
        _ => bail!("unknown protocol frame kind"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn json_frame_round_trip() {
        let mut bytes = Vec::new();
        FrameWriter::new(&mut bytes)
            .json(&serde_json::json!({"v": 1, "id": "12345678", "ok": true}))
            .unwrap();
        match read_frame(&mut bytes.as_slice()).unwrap().unwrap() {
            Frame::Json(value) => assert_eq!(value["ok"], true),
            _ => panic!("expected JSON frame"),
        }
    }

    #[test]
    fn binary_frame_round_trip() {
        let mut bytes = Vec::new();
        FrameWriter::new(&mut bytes)
            .binary("12345678", &[1, 2, 3, 4])
            .unwrap();
        match read_frame(&mut bytes.as_slice()).unwrap().unwrap() {
            Frame::Binary { request_id, bytes } => {
                assert_eq!(request_id, "12345678");
                assert_eq!(bytes, [1, 2, 3, 4]);
            }
            _ => panic!("expected binary frame"),
        }
    }

    #[test]
    fn rejects_oversized_length_before_allocation() {
        let mut bytes = Vec::from(((MAX_BINARY_FRAME + 1024) as u32).to_le_bytes());
        bytes.push(KIND_BINARY);
        assert!(read_frame(&mut bytes.as_slice()).is_err());
    }
}
