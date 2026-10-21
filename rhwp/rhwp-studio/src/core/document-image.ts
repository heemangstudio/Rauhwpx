/**
 * 문서에 넣는 그림을 한컴이 그대로 그릴 수 있는 바이트로 맞춘다.
 *
 * 브라우저는 WebP 와 EXIF 회전 JPEG 를 바르게 보여 주지만 한컴 2022 는 WebP 를 깨진 그림으로
 * 그리고 EXIF 회전을 무시한다. 회전된 사진은
 * 브라우저가 잰 (회전 후) 크기로 틀이 잡히므로 한컴에서 옆으로 누운 채 찌그러진다.
 * 이런 그림만 캔버스로 다시 인코딩하고 나머지는 원본 바이트를 그대로 둔다.
 */
import { cropImageOnCanvas, type ImageCropper } from '../agent/image-crop.ts';

export type DocumentImageFormat = 'png' | 'jpg' | 'gif' | 'bmp' | 'webp' | 'unknown';

export type DocumentImageReencodeReason = 'format' | 'orientation';

export interface PreparedDocumentImage {
  bytes: Uint8Array;
  extension: string;
  /** 다시 인코딩했으면 그 까닭 */
  reencoded: DocumentImageReencodeReason | null;
}

export function sniffDocumentImageFormat(bytes: Uint8Array): DocumentImageFormat {
  const b = bytes;
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'png';
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'jpg';
  if (b.length >= 6 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38) return 'gif';
  if (b.length >= 2 && b[0] === 0x42 && b[1] === 0x4d) return 'bmp';
  if (
    b.length >= 12
    && b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46
    && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50
  ) return 'webp';
  return 'unknown';
}

/** JPEG APP1 Exif 의 Orientation(1~8). 태그가 없거나 JPEG 가 아니면 1. */
export function jpegExifOrientation(bytes: Uint8Array): number {
  if (sniffDocumentImageFormat(bytes) !== 'jpg') return 1;
  let pos = 2;
  while (pos + 4 <= bytes.length) {
    if (bytes[pos] !== 0xff) return 1;
    const marker = bytes[pos + 1];
    // SOS 이후는 그림 데이터다 — Exif 는 그 앞에만 있다.
    if (marker === 0xda || marker === 0xd9) return 1;
    const length = (bytes[pos + 2] << 8) | bytes[pos + 3];
    if (length < 2) return 1;
    const start = pos + 4;
    const end = Math.min(bytes.length, pos + 2 + length);
    if (
      marker === 0xe1
      && end - start >= 14
      && bytes[start] === 0x45 && bytes[start + 1] === 0x78 && bytes[start + 2] === 0x69
      && bytes[start + 3] === 0x66 && bytes[start + 4] === 0 && bytes[start + 5] === 0
    ) {
      return tiffOrientation(bytes.subarray(start + 6, end));
    }
    pos += 2 + length;
  }
  return 1;
}

function tiffOrientation(tiff: Uint8Array): number {
  if (tiff.length < 8) return 1;
  const little = tiff[0] === 0x49 && tiff[1] === 0x49;
  if (!little && !(tiff[0] === 0x4d && tiff[1] === 0x4d)) return 1;
  const u16 = (o: number) => (little ? tiff[o] | (tiff[o + 1] << 8) : (tiff[o] << 8) | tiff[o + 1]);
  const u32 = (o: number) => (little
    ? (tiff[o] | (tiff[o + 1] << 8) | (tiff[o + 2] << 16) | (tiff[o + 3] << 24)) >>> 0
    : ((tiff[o] << 24) | (tiff[o + 1] << 16) | (tiff[o + 2] << 8) | tiff[o + 3]) >>> 0);
  const ifd = u32(4);
  if (ifd + 2 > tiff.length) return 1;
  const count = u16(ifd);
  for (let i = 0; i < count; i++) {
    const entry = ifd + 2 + i * 12;
    if (entry + 12 > tiff.length) return 1;
    if (u16(entry) === 0x0112) {
      const value = u16(entry + 8);
      return value >= 1 && value <= 8 ? value : 1;
    }
  }
  return 1;
}

/** 한컴에서 원본 그대로는 바르게 보이지 않는 그림이면 그 까닭, 아니면 null. */
export function documentImageReencodeReason(bytes: Uint8Array): DocumentImageReencodeReason | null {
  const format = sniffDocumentImageFormat(bytes);
  if (format === 'webp' || format === 'unknown') return 'format';
  if (format === 'jpg' && jpegExifOrientation(bytes) !== 1) return 'orientation';
  return null;
}

const MIME_BY_FORMAT: Record<DocumentImageFormat, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  gif: 'image/gif',
  bmp: 'image/bmp',
  webp: 'image/webp',
  unknown: '',
};

/**
 * 삽입 직전에 부른다. 다시 인코딩한 그림은 브라우저가 보여 주는 방향·크기 그대로라서
 * 호출부가 `<img>` 로 잰 naturalWidth/Height 와 맞는다.
 */
export async function prepareDocumentImage(
  bytes: Uint8Array,
  extension: string,
  mimeType?: string,
  reencode: ImageCropper = cropImageOnCanvas,
): Promise<PreparedDocumentImage> {
  const reason = documentImageReencodeReason(bytes);
  if (!reason) return { bytes, extension, reencoded: null };
  const format = sniffDocumentImageFormat(bytes);
  const output = format === 'jpg' ? 'image/jpeg' : 'image/png';
  const sourceMime = format === 'unknown'
    ? mimeType || `image/${extension.toLowerCase()}`
    : MIME_BY_FORMAT[format];
  const out = await reencode({ bytes, mimeType: sourceMime, output });
  return {
    bytes: out.bytes,
    extension: out.mimeType === 'image/jpeg' ? 'jpg' : 'png',
    reencoded: reason,
  };
}
