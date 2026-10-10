// A storage reader whose renderer dies after the page loaded, to exercise the immediate failure path.
window.addEventListener('load', () => setTimeout(() => process.crash(), 50));
