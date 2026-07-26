use anyhow::{Context, Result};
use std::mem::size_of;
use std::os::windows::io::AsRawHandle;
use std::process::Child;
use windows::core::PCWSTR;
use windows::Win32::Foundation::{CloseHandle, HANDLE};
use windows::Win32::System::JobObjects::{
    AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
    SetInformationJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
    JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
};

pub struct KillOnCloseJob(HANDLE);

unsafe impl Send for KillOnCloseJob {}
unsafe impl Sync for KillOnCloseJob {}

impl KillOnCloseJob {
    pub fn create() -> Result<Self> {
        unsafe {
            let handle =
                CreateJobObjectW(None, PCWSTR::null()).context("create helper job object")?;
            let mut information = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
            information.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            if let Err(error) = SetInformationJobObject(
                handle,
                JobObjectExtendedLimitInformation,
                (&information as *const JOBOBJECT_EXTENDED_LIMIT_INFORMATION).cast(),
                size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            ) {
                let _ = CloseHandle(handle);
                return Err(error).context("configure helper job object");
            }
            Ok(Self(handle))
        }
    }

    pub fn assign(&self, child: &Child) -> Result<()> {
        let process = HANDLE(child.as_raw_handle() as isize);
        unsafe { AssignProcessToJobObject(self.0, process) }
            .context("assign helper worker to kill-on-close job")
    }
}

impl Drop for KillOnCloseJob {
    fn drop(&mut self) {
        unsafe {
            let _ = CloseHandle(self.0);
        }
    }
}
