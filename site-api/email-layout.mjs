/**
 * Shared layout for every outgoing email: banner, content card, CTA button, footer.
 * Table layout + inline CSS so it survives Gmail, Apple Mail and Outlook.
 * Image URLs must be https PNGs (Gmail drops SVG and data: URIs) or a `cid:` reference.
 * The PNGs live in website/assets/email/ and are served by GitHub Pages.
 */

export const EMAIL_ASSET_BASE = 'https://heemangstudios.com/assets/email/';
export const EMAIL_BANNER_URL = `${EMAIL_ASSET_BASE}banner.png`;
export const EMAIL_KEY_ICON_URL = `${EMAIL_ASSET_BASE}key-icon@2x.png`;
export const EMAIL_CARD_BG_URL = `${EMAIL_ASSET_BASE}card-stars.png`;
export const SITE_URL = 'https://heemangstudios.com/';
export const SUPPORT_EMAIL = 'management@heemangstudios.com';

const FONT = "-apple-system,BlinkMacSystemFont,'Apple SD Gothic Neo','Pretendard','Malgun Gothic','Segoe UI',Roboto,sans-serif";
const MONO = "ui-monospace,SFMono-Regular,Menlo,Consolas,'Liberation Mono',monospace";
const CARD_EDGE = '#2f73a0';
const CARD_FILL = '#0f1720';
const SHEET = '#fcfcfb';
const U = 6; // pixel step of the frame, in px

export function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

export function emailBanner({ url = EMAIL_BANNER_URL, alt = 'HamaEditor' } = {}) {
  return `<tr><td style="border-radius:14px 14px 0 0;overflow:hidden;background:#0b0f14;" bgcolor="#0b0f14">
        <a href="${escapeHtml(SITE_URL)}" style="display:block;"><img src="${escapeHtml(url)}" width="600" alt="${escapeHtml(alt)}" style="display:block;width:100%;max-width:600px;height:auto;border:0;border-radius:14px 14px 0 0;image-rendering:pixelated;color:#ececea;font:700 20px ${FONT};"></a>
      </td></tr>`;
}

/** One row of the stepped frame: [sheet inset][edge][fill][edge][sheet inset], U px tall. */
function frameRow(inset, edge) {
  const cell = (w, color, cls = '') => `<td${cls ? ` class="${cls}"` : ''} width="${w}" height="${U}" bgcolor="${color}" style="width:${w}px;height:${U}px;background:${color};font-size:0;line-height:0;">&nbsp;</td>`;
  const mid = edge
    ? `${cell(U, CARD_EDGE)}<td height="${U}" bgcolor="${CARD_FILL}" style="height:${U}px;background:${CARD_FILL};font-size:0;line-height:0;">&nbsp;</td>${cell(U, CARD_EDGE)}`
    : `<td height="${U}" bgcolor="${CARD_EDGE}" style="height:${U}px;background:${CARD_EDGE};font-size:0;line-height:0;">&nbsp;</td>`;
  return `<tr><td><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>${cell(inset, SHEET, 'sheet')}${mid}${cell(inset, SHEET, 'sheet')}</tr></table></td></tr>`;
}

/**
 * Pixel-stepped frame with a starfield fill, holding one value (a license key or the email's main fact)
 * and an optional caption line. Pass `iconUrl: ''` to drop the key icon.
 */
export function emailCard({ value, caption = '', iconUrl = EMAIL_KEY_ICON_URL, bgUrl = EMAIL_CARD_BG_URL }) {
  const bg = escapeHtml(bgUrl);
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
          ${frameRow(2 * U, false)}
          ${frameRow(U, true)}
          <tr><td><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>
            <td width="${U}" bgcolor="${CARD_EDGE}" style="width:${U}px;background:${CARD_EDGE};font-size:0;line-height:0;">&nbsp;</td>
            <td align="center" bgcolor="${CARD_FILL}" background="${bg}" style="background:${CARD_FILL} url('${bg}') repeat;padding:30px 20px 32px 20px;">
              ${iconUrl ? `<img src="${escapeHtml(iconUrl)}" width="72" height="32" alt="" style="display:block;margin:0 auto 18px auto;width:72px;height:32px;border:0;image-rendering:pixelated;">` : ''}
              <p class="key" style="margin:0;font:700 19px/1.5 ${MONO};letter-spacing:2px;color:#e6f5ff;text-shadow:0 0 14px rgba(98,179,226,.55);-webkit-user-select:all;user-select:all;">${escapeHtml(value)}</p>${caption ? `
              <p style="margin:10px 0 0 0;font:13px/1.5 ${MONO};color:#9fc4dc;">${escapeHtml(caption)}</p>` : ''}
            </td>
            <td width="${U}" bgcolor="${CARD_EDGE}" style="width:${U}px;background:${CARD_EDGE};font-size:0;line-height:0;">&nbsp;</td>
          </tr></table></td></tr>
          ${frameRow(U, true)}
          ${frameRow(2 * U, false)}
        </table>`;
}

/** Bulletproof button (VML for Outlook), with an optional caption underneath. */
export function emailButton({ href, label, icon = '', caption = '' }) {
  const url = escapeHtml(href);
  const text = escapeHtml(label);
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
          <tr><td align="center" style="padding:30px 0 6px 0;">
            <!--[if mso]>
            <v:roundrect xmlns:v="urn:schemas-microsoft-com:vml" xmlns:w="urn:schemas-microsoft-com:office:word" href="${url}" style="height:54px;v-text-anchor:middle;width:300px;" arcsize="18%" stroke="f" fillcolor="#2f73a0">
              <w:anchorlock/><center style="color:#ffffff;font-family:sans-serif;font-size:17px;font-weight:bold;">${text}</center>
            </v:roundrect>
            <![endif]-->
            <!--[if !mso]><!-->
            <a href="${url}" style="display:inline-block;background:#2f73a0;border-bottom:4px solid #1d4766;color:#ffffff;font:800 17px/54px ${FONT};padding:0 40px;border-radius:10px;min-width:220px;text-align:center;">${icon ? `${icon}&nbsp; ` : ''}${text}</a>
            <!--<![endif]-->
          </td></tr>${caption ? `
          <tr><td align="center" class="muted" style="padding:6px 0 0 0;font:13px/1.5 ${FONT};color:#8d8d8a;">${escapeHtml(caption)}</td></tr>` : ''}
        </table>`;
}

export function emailFooter() {
  return `<tr><td align="center" style="padding:22px 12px 6px 12px;font:12px/1.7 ${FONT};color:#8d8d8a;">
        <a href="${escapeHtml(SITE_URL)}" style="color:#62625f;font-weight:700;">HamaEditor</a> · HWP/HWPX 편집기 for Mac<br>
        <a href="https://heemangstudios.com/pricing.html" style="color:#8d8d8a;text-decoration:underline;">가격</a> &nbsp;·&nbsp;
        <a href="https://heemangstudios.com/tos.html" style="color:#8d8d8a;text-decoration:underline;">이용약관</a> &nbsp;·&nbsp;
        <a href="mailto:${SUPPORT_EMAIL}" style="color:#8d8d8a;text-decoration:underline;">문의</a>
      </td></tr>`;
}

/** One centered line under the card, outside its frame (a date or term that belongs with the card's value). */
export function emailCardNote(text) {
  return `<p class="t2" style="margin:16px 0 0 0;text-align:center;font:15px/1.6 ${FONT};color:#3a3a38;">${escapeHtml(text)}</p>`;
}

/**
 * Full HTML document. `noteHtml` is trusted markup (it may carry <strong>);
 * every other string is escaped. `card`, `cardNote` and `cta` are optional.
 */
export function renderEmail({ subject, preheader, banner = {}, heading, noteHtml, card, cardNote = '', cta }) {
  return `<!DOCTYPE html>
<html lang="ko" xmlns="http://www.w3.org/1999/xhtml" xmlns:v="urn:schemas-microsoft-com:vml" xmlns:o="urn:schemas-microsoft-com:office:office">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="x-apple-disable-message-reformatting">
<meta name="color-scheme" content="light dark">
<meta name="supported-color-schemes" content="light dark">
<title>${escapeHtml(subject)}</title>
<style>
  body{margin:0;padding:0;}
  a{text-decoration:none;}
  @media (max-width:620px){
    .container{width:100%!important;}
    .px{padding-left:22px!important;padding-right:22px!important;}
    .key{font-size:15px!important;letter-spacing:1px!important;}
  }
  @media (prefers-color-scheme:dark){
    .ground{background:#111418!important;}
    .sheet{background:#1e1e1d!important;}
    .t1{color:#ececea!important;}
    .t2{color:#c9c9c6!important;}
    .muted{color:#a8a8a5!important;}
  }
</style>
</head>
<body style="margin:0;padding:0;background:#ececea;">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;mso-hide:all;">${escapeHtml(preheader)}&#8199;&#65279;&#847;&#8199;&#65279;&#847;&#8199;&#65279;&#847;&#8199;&#65279;&#847;</div>
<table role="presentation" class="ground" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="#ececea" style="background:#ececea;">
  <tr><td align="center" style="padding:28px 12px;">
    <!--[if mso]><table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0"><tr><td><![endif]-->
    <table role="presentation" class="container" width="600" cellpadding="0" cellspacing="0" border="0" style="width:600px;max-width:600px;">
      <!-- banner -->
      ${emailBanner(banner)}
      <!-- sheet -->
      <tr><td class="sheet px" bgcolor="#fcfcfb" style="background:#fcfcfb;padding:36px 44px 36px 44px;border-radius:0 0 14px 14px;">
        <h1 class="t1" style="margin:0 0 12px 0;font:800 26px/1.35 ${FONT};color:#1b1b1a;letter-spacing:-.3px;">${escapeHtml(heading)}</h1>
        <p class="t2" style="margin:0 0 26px 0;font:16px/1.65 ${FONT};color:#3a3a38;">${noteHtml}</p>
${card ? `
        <!-- card: pixel-stepped frame, starfield fill -->
        ${emailCard(card)}${cardNote ? `
        ${emailCardNote(cardNote)}` : ''}
` : ''}${cta ? `
        <!-- CTA -->
        ${emailButton(cta)}
` : ''}
      </td></tr>
      <!-- footer -->
      ${emailFooter()}
    </table>
    <!--[if mso]></td></tr></table><![endif]-->
  </td></tr>
</table>
</body>
</html>`;
}
