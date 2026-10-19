// 선물 크레딧을 쓰는 데스크톱 플랫폼. 데스크톱 main 과 허브가 같이 쓴다.
// 서버는 따로 배포되므로 같은 목록을 site-api/gifts.mjs 의 DEFAULT_GIFT_PLATFORMS 로 가진다.
export const GIFT_PLATFORMS = Object.freeze(['darwin', 'win32']);

export function isGiftPlatform(platform) {
  return GIFT_PLATFORMS.includes(platform);
}
