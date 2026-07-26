#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum CaptureWorkerBackend {
    Wgc,
    Gdi,
}

impl CaptureWorkerBackend {
    pub fn as_arg(self) -> &'static str {
        match self {
            Self::Wgc => "wgc",
            Self::Gdi => "gdi",
        }
    }

    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "wgc" => Some(Self::Wgc),
            "gdi" => Some(Self::Gdi),
            _ => None,
        }
    }
}

#[derive(Debug, Eq, PartialEq)]
pub struct CaptureAttemptFailures<E> {
    pub wgc: E,
    pub gdi: E,
}

pub fn capture_with_gdi_fallback<T, E>(
    mut attempt: impl FnMut(CaptureWorkerBackend) -> Result<T, E>,
) -> Result<(T, CaptureWorkerBackend), CaptureAttemptFailures<E>> {
    let wgc = match attempt(CaptureWorkerBackend::Wgc) {
        Ok(value) => return Ok((value, CaptureWorkerBackend::Wgc)),
        Err(error) => error,
    };
    match attempt(CaptureWorkerBackend::Gdi) {
        Ok(value) => Ok((value, CaptureWorkerBackend::Gdi)),
        Err(gdi) => Err(CaptureAttemptFailures { wgc, gdi }),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn abnormal_wgc_result_uses_a_fresh_gdi_attempt() {
        let mut attempts = Vec::new();
        let result = capture_with_gdi_fallback(|backend| {
            attempts.push(backend);
            match backend {
                CaptureWorkerBackend::Wgc => Err("0xC0000005"),
                CaptureWorkerBackend::Gdi => Ok("frame"),
            }
        });

        assert_eq!(result, Ok(("frame", CaptureWorkerBackend::Gdi)));
        assert_eq!(
            attempts,
            [CaptureWorkerBackend::Wgc, CaptureWorkerBackend::Gdi]
        );
    }

    #[test]
    fn double_failure_does_not_poison_the_next_capture_plan() {
        let failed = capture_with_gdi_fallback::<(), _>(|backend| match backend {
            CaptureWorkerBackend::Wgc => Err("wgc crashed"),
            CaptureWorkerBackend::Gdi => Err("gdi crashed"),
        });
        assert_eq!(
            failed,
            Err(CaptureAttemptFailures {
                wgc: "wgc crashed",
                gdi: "gdi crashed"
            })
        );

        let next = capture_with_gdi_fallback(|backend| match backend {
            CaptureWorkerBackend::Wgc => Ok("next frame"),
            CaptureWorkerBackend::Gdi => Err("must not run"),
        });
        assert_eq!(next, Ok(("next frame", CaptureWorkerBackend::Wgc)));
    }
}
