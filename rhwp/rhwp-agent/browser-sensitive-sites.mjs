// 계정 제공자(메일 포함), 금융·결제, 가상자산, 공공 인증 사이트는 에이전트가 로그인하지 않는다.
// 로그아웃 상태로 읽는 것은 허용한다. 로그인은 사용자가 에이전트 탭의 조작권을 가져와 직접 한다.
const SENSITIVE_DOMAINS = [
  'google.com', 'gmail.com', 'naver.com', 'kakao.com', 'daum.net', 'apple.com', 'icloud.com',
  'microsoft.com', 'microsoftonline.com', 'live.com', 'outlook.com', 'yahoo.com', 'proton.me',
  'kbstar.com', 'kbcard.com', 'shinhan.com', 'shinhancard.com', 'wooribank.com', 'wooricard.com',
  'hanabank.com', 'hanacard.co.kr', 'nonghyup.com', 'nhbank.com', 'ibk.co.kr', 'kdb.co.kr',
  'busanbank.co.kr', 'kakaobank.com', 'tossbank.com', 'toss.im', 'samsungcard.com', 'hyundaicard.com',
  'lottecard.co.kr', 'bccard.com', 'samsungpop.com', 'miraeasset.com', 'kiwoom.com',
  'koreainvestment.com', 'nhqv.com', 'paypal.com', 'stripe.com', 'wise.com', 'chase.com',
  'bankofamerica.com', 'wellsfargo.com', 'citi.com', 'hsbc.com', 'schwab.com', 'fidelity.com',
  'robinhood.com',
  'upbit.com', 'bithumb.com', 'coinone.co.kr', 'korbit.co.kr', 'binance.com', 'coinbase.com',
  'kraken.com', 'okx.com', 'bybit.com',
  'go.kr', 'gov.kr', 'nhis.or.kr', 'nps.or.kr', 'irs.gov', 'login.gov', 'ssa.gov',
];

export const SENSITIVE_SITE_MESSAGE = 'Agents do not sign in to account-provider, email, banking, payment, crypto or government sites. Ask the user to take control of this tab (직접 조작) and sign in themselves; continue after they return control.';

export function sensitiveSite(url) {
  let host;
  try { host = new URL(url).hostname.toLowerCase(); } catch { return false; }
  return SENSITIVE_DOMAINS.some((domain) => host === domain || host.endsWith(`.${domain}`));
}
