// 앱 안 업그레이드 카드의 Groble 결제 링크. 링크는 이 파일에만 둔다.
// 빈 링크(또는 groble.im 의 https 주소가 아닌 값)는 '곧 출시'로 보이고 결제를 시작하지 않는다.
// 앱은 링크 뒤에 ?ref=<무작위 값>을 붙여 열고, 키 서버의 /v1/license/by-ref 로 결제를 확인한다.
// Hama 는 내 AI 연결, Rau 는 호스팅 Rau 에이전트와 Rau 모드다.
export const PLAN_CHECKOUT = Object.freeze({
  hamaMonthly: Object.freeze({ url: 'https://groble.im/payment/SfYBy5', priceKrw: 3900 }),
  hamaYearly: Object.freeze({ url: 'https://groble.im/payment/vdw3HN', priceKrw: 39000 }),
  rauMonthly: Object.freeze({ url: 'https://groble.im/payment/R3n8zG', priceKrw: 14900 }),
  rauYearly: Object.freeze({ url: 'https://groble.im/payment/atqjpJ', priceKrw: 149000 }),
});
