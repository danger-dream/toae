mod protocol;

#[cfg(windows)]
mod ahk;
#[cfg(windows)]
mod clipboard;
#[cfg(windows)]
mod compositor;
#[cfg(windows)]
mod job;
#[cfg(windows)]
mod overlay;
#[cfg(windows)]
mod overlay_editor;
#[cfg(windows)]
mod selection;
#[cfg(windows)]
mod supervisor;

use anyhow::{bail, Context, Result};
use std::collections::HashMap;
use std::path::PathBuf;

fn main() {
    if let Err(error) = run() {
        // stderr is a log-only channel. Never write protocol or user content here.
        eprintln!("native-helper: {error:#}");
        std::process::exit(1);
    }
}

fn run() -> Result<()> {
    let args = parse_args(std::env::args().skip(1))?;
    #[cfg(windows)]
    {
        if args.flag("--supervisor") {
            return supervisor::run(supervisor::SupervisorOptions {
                protocol: args.required_u64("--protocol")?,
                session_token: args.required_string("--session-token")?,
                script_path: args.required_path("--script")?,
                expected_dll_sha256: args.required_string("--dll-sha256")?,
            });
        }
        if args.flag("--hook") {
            return ahk::run_hook(ahk::HookOptions {
                session_token: args.required_string("--session-token")?,
                script_path: args.required_path("--script")?,
                expected_dll_sha256: args.required_string("--dll-sha256")?,
            });
        }
        if args.flag("--uia-worker") {
            return selection::run_uia_worker(args.required_string("--session-token")?);
        }
        if args.flag("--capture-overlay") {
            return overlay::run();
        }
        bail!("a supported helper mode is required");
    }
    #[cfg(not(windows))]
    {
        let _ = args;
        bail!("native-helper is supported only on Windows x64");
    }
}

#[derive(Default)]
struct Arguments {
    flags: HashMap<String, Option<String>>,
}

impl Arguments {
    fn flag(&self, key: &str) -> bool {
        self.flags.contains_key(key)
    }

    #[cfg(windows)]
    fn required_string(&self, key: &str) -> Result<String> {
        self.flags
            .get(key)
            .and_then(Clone::clone)
            .filter(|value| !value.is_empty())
            .with_context(|| format!("missing argument {key}"))
    }

    #[cfg(windows)]
    fn required_u64(&self, key: &str) -> Result<u64> {
        self.required_string(key)?
            .parse::<u64>()
            .with_context(|| format!("invalid argument {key}"))
    }

    #[cfg(windows)]
    fn required_path(&self, key: &str) -> Result<PathBuf> {
        let path = PathBuf::from(self.required_string(key)?);
        if !path.is_absolute() {
            bail!("argument {key} must be an absolute path");
        }
        Ok(path)
    }
}

fn parse_args(args: impl Iterator<Item = String>) -> Result<Arguments> {
    let mut parsed = Arguments::default();
    let values: Vec<String> = args.collect();
    let mut index = 0;
    while index < values.len() {
        let key = &values[index];
        if !key.starts_with("--") || parsed.flags.contains_key(key) {
            bail!("invalid or duplicate argument");
        }
        let takes_value = matches!(
            key.as_str(),
            "--protocol" | "--session-token" | "--script" | "--dll-sha256"
        );
        if takes_value {
            let value = values.get(index + 1).context("missing argument value")?;
            if value.starts_with("--") {
                bail!("missing argument value");
            }
            parsed.flags.insert(key.clone(), Some(value.clone()));
            index += 2;
        } else if matches!(
            key.as_str(),
            "--supervisor" | "--hook" | "--uia-worker" | "--capture-overlay"
        ) {
            parsed.flags.insert(key.clone(), None);
            index += 1;
        } else {
            bail!("unknown argument");
        }
    }
    Ok(parsed)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_fixed_modes_and_values() {
        let args = parse_args(
            ["--supervisor", "--protocol", "1", "--session-token", "abc"]
                .into_iter()
                .map(str::to_owned),
        )
        .unwrap();
        assert!(args.flag("--supervisor"));
        assert_eq!(args.flags["--protocol"].as_deref(), Some("1"));
    }

    #[test]
    fn rejects_unknown_and_duplicate_arguments() {
        assert!(parse_args(["--unknown"].into_iter().map(str::to_owned)).is_err());
        assert!(parse_args(["--hook", "--hook"].into_iter().map(str::to_owned)).is_err());
    }
}
