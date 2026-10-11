/** 대화의 웹 링크를 앱 브라우저로 열고 문서 카드의 전용 동작은 유지한다. */
export function routeChatBrowserLinks(host: HTMLElement, open: (url: string) => Promise<void>, onError: (error: unknown) => void): void {
  const route = (event: MouseEvent): void => {
    if (event.defaultPrevented || event.button > 1 || !(event.target instanceof Element)) return;
    const link = event.target.closest<HTMLAnchorElement>('a[href]');
    if (!link || !host.contains(link) || link.hasAttribute('download')
      || link.closest('.ag-md-artifact-card') || link.classList.contains('ag-md-artifact-open')) return;
    const url = new URL(link.href);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return;
    event.preventDefault();
    void open(url.href).catch(onError);
  };
  host.addEventListener('click', route);
  host.addEventListener('auxclick', route);
}
