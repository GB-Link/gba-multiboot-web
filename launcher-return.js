// launcher-return.js
// Shows a small "Return to launcher" button when this client was opened from the
// GB Link launcher (URL contains ?from=gblink-launcher). Self-contained: no deps,
// no external CSS. Safe to load from any framework — it appends a fixed-position
// element to <body> after load.
(function () {
  var LAUNCHER_URL = 'https://launcher.gblink.io';
  var FROM_KEY = 'from';
  var FROM_VALUE = 'gblink-launcher';

  try {
    if (new URLSearchParams(window.location.search).get(FROM_KEY) !== FROM_VALUE) return;
  } catch (e) {
    return;
  }

  function mount() {
    if (document.getElementById('gblink-launcher-return')) return;
    var a = document.createElement('a');
    a.id = 'gblink-launcher-return';
    a.href = LAUNCHER_URL;
    a.setAttribute('aria-label', 'Return to the GB Link launcher');
    a.innerHTML =
      '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor"' +
      ' stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
      '<line x1="19" y1="12" x2="5" y2="12"></line>' +
      '<polyline points="12 19 5 12 12 5"></polyline></svg>' +
      '<span>Launcher</span>';
    a.style.cssText = [
      'position:fixed', 'top:12px', 'left:12px', 'z-index:2147483647',
      'display:inline-flex', 'align-items:center', 'gap:6px',
      'padding:7px 12px', 'box-sizing:border-box',
      'font:600 13px/1 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif',
      'color:#fff', 'text-decoration:none', 'white-space:nowrap',
      'background:rgba(20,22,30,0.78)', 'border:1px solid rgba(255,255,255,0.18)',
      'border-radius:9px', 'backdrop-filter:blur(6px)',
      '-webkit-backdrop-filter:blur(6px)', 'box-shadow:0 2px 10px rgba(0,0,0,0.35)',
      'cursor:pointer', 'transition:background 0.15s ease'
    ].join(';');
    a.onmouseenter = function () { a.style.background = 'rgba(40,44,58,0.92)'; };
    a.onmouseleave = function () { a.style.background = 'rgba(20,22,30,0.78)'; };
    document.body.appendChild(a);
  }

  if (document.body) mount();
  else document.addEventListener('DOMContentLoaded', mount);
})();
