impl crate::wmf::parser::META_ESCAPE {
    pub(in crate::wmf::parser::records::escape) fn parse_as_GETCOLORTABLE<R: crate::wmf::Read>(
        buf: &mut R,
        mut record_size: crate::wmf::parser::RecordSize,
        record_function: u16,
    ) -> Result<Self, crate::wmf::parser::ParseError> {
        let ((byte_count, byte_count_bytes), (start, start_bytes)) = (
            crate::wmf::parser::read_u16_from_le_bytes(buf)?,
            crate::wmf::parser::read_u16_from_le_bytes(buf)?,
        );
        record_size.consume(byte_count_bytes + start_bytes);
        let (_, c) = crate::wmf::parser::read_variable(buf, start as usize)?;
        record_size.consume(c);

        // start > byte_count 면 u16 뺄셈이 넘친다 (디버그 패닉/릴리스 wrap).
        let color_table_len = byte_count.checked_sub(start).ok_or_else(|| {
            crate::wmf::parser::ParseError::UnexpectedPattern {
                cause: format!(
                    "The start `{start}` field must not exceed byte_count `{byte_count}`"
                ),
            }
        })?;
        let (color_table_buffer, c) =
            crate::wmf::parser::read_variable(buf, color_table_len as usize)?;
        record_size.consume(c);

        crate::wmf::parser::records::consume_remaining_bytes(buf, record_size)?;

        Ok(Self::GETCOLORTABLE {
            record_size,
            record_function,
            byte_count,
            start,
            color_table_buffer,
        })
    }
}
