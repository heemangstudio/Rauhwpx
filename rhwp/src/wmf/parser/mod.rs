mod constants;
mod objects;
mod records;

pub use self::{constants::*, objects::*, records::*};
use crate::wmf::imports::*;

#[derive(Clone, Debug, snafu::prelude::Snafu)]
pub enum ParseError {
    #[snafu(display("failed to read buffer: {cause}"))]
    FailedReadBuffer { cause: ReadError },
    #[snafu(display("not supported: {cause}"))]
    NotSupported { cause: String },
    #[snafu(display("unexpected enum value: {cause}"))]
    UnexpectedEnumValue { cause: String },
    #[snafu(display("unexpected bytes pattern: {cause}"))]
    UnexpectedPattern { cause: String },
}

impl From<ReadError> for ParseError {
    fn from(err: ReadError) -> Self {
        Self::FailedReadBuffer { cause: err }
    }
}

#[derive(Clone, Debug, snafu::prelude::Snafu)]
#[snafu(display("failed to read buffer: {cause}"))]
pub struct ReadError {
    cause: String,
}

impl ReadError {
    pub fn new(err: impl core::fmt::Display) -> Self {
        Self {
            cause: err.to_string(),
        }
    }
}

pub fn read<R: crate::wmf::Read, const N: usize>(
    buf: &mut R,
) -> Result<([u8; N], usize), ReadError> {
    let mut buffer = [0u8; N];

    match buf.read(&mut buffer) {
        Ok(bytes_read) if bytes_read == N => Ok((buffer, N)),
        Ok(bytes_read) => Err(ReadError::new(format!(
            "expected {N} bytes read, but {bytes_read} bytes read"
        ))),
        Err(err) => Err(ReadError::new(format!("{err:?}"))),
    }
}

/// `read_variable` 이 선언 길이만큼 미리 잡아 두는 최대 용량.
const READ_VARIABLE_INITIAL_CAPACITY: usize = 64 * 1024;
/// `read_variable` 이 한 번에 읽는 조각 크기.
const READ_VARIABLE_CHUNK: usize = 8 * 1024;

/// 가변 길이 필드를 `len` 바이트 읽는다.
///
/// `len` 은 레코드 크기·DIB 헤더 등 신뢰할 수 없는 필드에서 온다. 예전처럼
/// `vec![0; len]` 으로 먼저 0 을 채우면 30바이트짜리 WMF 가 4 GB 를 요구해
/// wasm32 에서 capacity overflow 패닉/할당 abort 로 끝난다. 실제로 읽힌 만큼만
/// 버퍼를 키워, 입력이 모자라면 할당 없이 짧은 읽기 오류를 돌려준다.
pub fn read_variable<R: crate::wmf::Read>(
    buf: &mut R,
    len: usize,
) -> Result<(Vec<u8>, usize), ReadError> {
    if len == 0 {
        return Ok((vec![0u8; 0], 0));
    }

    let mut buffer = Vec::with_capacity(len.min(READ_VARIABLE_INITIAL_CAPACITY));
    let mut chunk = [0u8; READ_VARIABLE_CHUNK];

    while buffer.len() < len {
        let want = (len - buffer.len()).min(READ_VARIABLE_CHUNK);

        match buf.read(&mut chunk[..want]) {
            Ok(0) => break,
            Ok(bytes_read) => buffer.extend_from_slice(&chunk[..bytes_read]),
            Err(err) => return Err(ReadError::new(format!("{err:?}"))),
        }
    }

    if buffer.len() == len {
        Ok((buffer, len))
    } else {
        Err(ReadError::new(format!(
            "expected {len} bytes read, but {} bytes read",
            buffer.len()
        )))
    }
}

macro_rules! impl_from_le_bytes {
    ($(($t:ty, $n:expr)),+) => {
        pastey::paste!{
            $(
                pub fn [<read_ $t _from_le_bytes>]<R: $crate::wmf::Read>(
                    buf: &mut R,
                ) -> Result<($t, usize), ReadError> {
                    let (bytes, consumed_bytes) = read::<R, $n>(buf)?;

                    Ok((<$t>::from_le_bytes(bytes), consumed_bytes))
                }
            )*
        }
    };
}

impl_from_le_bytes! {(i8, 1), (i16, 2), (i32, 4), (u8, 1), (u16, 2), (u32, 4) }

/// Converts the given byte slice to a UTF-8 string using the specified
/// character set.
///
/// # Arguments
///
/// - `bytes` - The byte slice to convert.
/// - `charset` - The character set indicating the encoding of the byte slice.
///
/// # Returns
///
/// - On success, returns a UTF-8 string.
/// - On failure to decode, returns a `ParseError`.
///
/// If `SYMBOL_CHARSET` is specified, the function uses the symbol charset table
/// for conversion. Otherwise, it decodes using the provided encoding and
/// removes any null ( `\0` ) characters from the result.
fn bytes_into_utf8(
    bytes: &[u8],
    charset: crate::wmf::parser::CharacterSet,
) -> Result<String, crate::wmf::parser::ParseError> {
    if charset == crate::wmf::parser::CharacterSet::SYMBOL_CHARSET {
        Ok(bytes
            .iter()
            .filter_map(|v| crate::wmf::parser::symbol_charset_table().get(v).copied())
            .collect::<String>()
            .replace('\0', ""))
    } else {
        let encoding: &'static encoding_rs::Encoding = charset.into();
        let (cow, _, had_errors) = encoding.decode(bytes);

        if had_errors {
            return Err(crate::wmf::parser::ParseError::UnexpectedPattern {
                cause: "Failed to decode string with specified charset".to_string(),
            });
        }

        Ok(cow.replace('\0', ""))
    }
}

#[cfg(test)]
mod tests {
    use super::read_variable;

    /// 선언 길이가 입력보다 터무니없이 크면 그만큼 할당하지 않고 짧은 읽기 오류를
    /// 돌려줘야 한다. 예전 `vec![0; len]` 은 여기서 수 EB 를 요구해 abort 했다.
    #[test]
    fn read_variable_rejects_huge_declared_length_without_allocating_it() {
        let data = [7u8; 10];
        let mut input = &data[..];

        let err = read_variable(&mut input, usize::MAX / 2).expect_err("short input must fail");
        assert!(err.to_string().contains("but 10 bytes read"), "{err}");
    }

    /// 조각 크기(8 KiB)를 넘는 길이도 정확히 그 바이트만 읽고 나머지는 남겨 둔다.
    #[test]
    fn read_variable_reads_exact_length_across_chunks() {
        let data: Vec<u8> = (0..20_000u32).map(|v| v as u8).collect();
        let mut input = data.as_slice();

        let (bytes, consumed) = read_variable(&mut input, 19_999).expect("full read");
        assert_eq!(consumed, 19_999);
        assert_eq!(bytes, data[..19_999]);
        assert_eq!(input, &data[19_999..]);
    }
}
