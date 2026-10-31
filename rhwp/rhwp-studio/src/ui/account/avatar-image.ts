// 계정 사진 준비. 고른 그림의 가운데를 정사각형으로 잘라 512px 안으로 줄이고,
// WebP(안 되면 JPEG)로 1 MiB 안에 들게 다시 담는다. 올리기는 main 이 한다(setAvatar).
import type { AccountAvatarType } from './account-types.ts';

export const AVATAR_SIZE = 512;
export const AVATAR_MAX_BYTES = 1024 * 1024;

/** 품질을 낮춰 가며 1 MiB 안에 들 때까지. WebP 를 못 만드는 환경은 JPEG 로 넘어간다. */
const ENCODINGS: ReadonlyArray<readonly [AccountAvatarType, number]> = [
  ['image/webp', 0.9], ['image/webp', 0.8], ['image/webp', 0.65],
  ['image/jpeg', 0.85], ['image/jpeg', 0.7], ['image/jpeg', 0.55], ['image/jpeg', 0.4],
];

export interface AvatarCrop {
  /** 원본에서 자를 정사각형의 왼쪽 위와 한 변. */
  sx: number;
  sy: number;
  side: number;
  /** 결과 한 변. 키우지 않는다. */
  size: number;
}

export function avatarCrop(width: number, height: number, max = AVATAR_SIZE): AvatarCrop {
  const w = Math.max(1, Math.floor(width));
  const h = Math.max(1, Math.floor(height));
  const side = Math.min(w, h);
  return {
    sx: Math.floor((w - side) / 2),
    sy: Math.floor((h - side) / 2),
    side,
    size: Math.min(max, side),
  };
}

export type AvatarEncoder = (type: AccountAvatarType, quality: number) => Promise<Blob | null>;

/** 1 MiB 안의 첫 결과. 모두 넘으면 null. 요청한 형식을 못 만들어 다른 형식이 오면 건너뛴다. */
export async function encodeAvatar(encode: AvatarEncoder): Promise<{ bytes: Uint8Array; type: AccountAvatarType } | null> {
  for (const [type, quality] of ENCODINGS) {
    const blob = await encode(type, quality).catch(() => null);
    if (!blob || blob.type !== type || blob.size > AVATAR_MAX_BYTES) continue;
    return { bytes: new Uint8Array(await blob.arrayBuffer()), type };
  }
  return null;
}

export type PreparedAvatar =
  | { ok: true; bytes: Uint8Array; type: AccountAvatarType }
  | { ok: false; code: 'unsupported_type' | 'too_large'; message: string };

/** 파일 고르기에서 받은 그림을 올릴 수 있는 꼴로. */
export async function prepareAvatar(file: Blob): Promise<PreparedAvatar> {
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    return { ok: false, code: 'unsupported_type', message: 'JPG, PNG, WebP 사진만 쓸 수 있어요.' };
  }
  const crop = avatarCrop(bitmap.width, bitmap.height);
  const canvas = document.createElement('canvas');
  canvas.width = crop.size;
  canvas.height = crop.size;
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    bitmap.close();
    return { ok: false, code: 'unsupported_type', message: 'JPG, PNG, WebP 사진만 쓸 수 있어요.' };
  }
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(bitmap, crop.sx, crop.sy, crop.side, crop.side, 0, 0, crop.size, crop.size);
  bitmap.close();
  const encoded = await encodeAvatar((type, quality) => new Promise((resolve) => canvas.toBlob(resolve, type, quality)));
  if (!encoded) return { ok: false, code: 'too_large', message: '사진이 너무 커요.' };
  return { ok: true, ...encoded };
}
