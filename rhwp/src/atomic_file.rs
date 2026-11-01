use std::fs::{self, File, OpenOptions};
use std::io::{self, Write};
use std::path::{Path, PathBuf};

pub(crate) fn write_atomically(output: &Path, bytes: &[u8]) -> io::Result<()> {
    // `std::fs::rename` uses replacement semantics on supported platforms. On
    // Windows it also preserves std's extended-length path normalization and
    // access-denied fallback, which a direct MoveFileExW call would bypass.
    write_atomically_with(output, bytes, |from, to| fs::rename(from, to))
}

fn write_atomically_with<F>(output: &Path, bytes: &[u8], replace: F) -> io::Result<()>
where
    F: FnOnce(&Path, &Path) -> io::Result<()>,
{
    let (temp_path, mut temp) = create_sibling_temp(output)?;
    if let Err(error) = write_and_sync(&mut temp, bytes) {
        drop(temp);
        cleanup_temp(&temp_path);
        return Err(error);
    }
    drop(temp);
    if let Err(error) = replace(&temp_path, output) {
        cleanup_temp(&temp_path);
        return Err(error);
    }
    Ok(())
}

fn create_sibling_temp(output: &Path) -> io::Result<(PathBuf, File)> {
    let parent = output.parent().filter(|path| !path.as_os_str().is_empty());
    let parent = parent.unwrap_or_else(|| Path::new("."));
    let nonce = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    for attempt in 0..128 {
        let candidate = parent.join(format!(
            ".rhwp-hml-{}.{}.{}.tmp",
            std::process::id(),
            nonce,
            attempt
        ));
        match OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&candidate)
        {
            Ok(file) => return Ok((candidate, file)),
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => continue,
            Err(error) => return Err(error),
        }
    }
    Err(io::Error::new(
        io::ErrorKind::AlreadyExists,
        "임시 출력 파일 이름을 확보할 수 없습니다",
    ))
}

fn write_and_sync(file: &mut File, bytes: &[u8]) -> io::Result<()> {
    file.write_all(bytes)?;
    file.sync_all()
}

fn cleanup_temp(path: &Path) {
    let _ = fs::remove_file(path);
}

