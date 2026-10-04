import { importLocalFontFiles } from './local-fonts.ts';

interface DevFontPackFace {
  name: string;
  size: number;
  url: string;
}

interface DevFontPackManifest {
  version: 1;
  fonts: DevFontPackFace[];
}

/** 개발 서버에 명시된 서체를 문서 첫 조판 전에 실제 파일 가져오기 경로로 등록한다. */
export async function loadConfiguredDevFontPack(
  onProgress?: (loaded: number, total: number) => void,
): Promise<number> {
  const response = await fetch('/__dev-font-pack/manifest.json', { cache: 'no-store' });
  if (!response.ok) throw new Error(`개발 글꼴 목록을 읽지 못했습니다 (${response.status})`);
  const manifest = await response.json() as DevFontPackManifest;
  if (manifest.version !== 1 || !Array.isArray(manifest.fonts) || manifest.fonts.length === 0) {
    throw new Error('개발 글꼴 목록 형식이 올바르지 않습니다');
  }
  for (const [index, face] of manifest.fonts.entries()) {
    if (typeof face.name !== 'string' || !/\.(ttf|otf)$/i.test(face.name)
      || typeof face.url !== 'string' || !/^\/__dev-font-pack\/file\/\d+\/[a-f0-9]{64}$/.test(face.url)
      || !Number.isSafeInteger(face.size) || face.size <= 0) {
      throw new Error(`개발 글꼴 목록의 ${index + 1}번째 항목이 올바르지 않습니다`);
    }
    const fontResponse = await fetch(face.url);
    if (!fontResponse.ok) throw new Error(`${face.name} 글꼴을 읽지 못했습니다 (${fontResponse.status})`);
    const bytes = await fontResponse.arrayBuffer();
    if (bytes.byteLength !== face.size) throw new Error(`${face.name} 글꼴 크기가 변경되었습니다`);
    const result = await importLocalFontFiles([new File([bytes], face.name)]);
    if (result.rejected.length || result.imported.length !== 1) {
      throw new Error(`${face.name} 글꼴을 가져오지 못했습니다`);
    }
    onProgress?.(index + 1, manifest.fonts.length);
  }
  return manifest.fonts.length;
}
