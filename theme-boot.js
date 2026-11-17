// Thème de Papote : chargé AVANT la page pour éviter un "flash" de la mauvaise couleur.
// Les choix (mode nuit, couleur, fond, taille du texte) sont gardés dans ce navigateur
// et, une fois connecté, dans ton compte (pour les retrouver sur ton téléphone aussi).
(function () {
  var DEFAULT = { theme: 'auto', accent: '#6d4aff', wallpaper: 'none', textSize: 'm' };
  var THEMES = ['auto', 'light', 'dark'];
  var WALLS = ['none', 'dots', 'grid', 'gradient', 'stars'];
  var SIZES = ['s', 'm', 'l'];
  var KEY = 'papote_prefs';
  var mq = window.matchMedia('(prefers-color-scheme: dark)');

  // On n'accepte que des valeurs connues (une valeur bizarre = valeur par défaut)
  function clean(p) {
    p = p || {};
    return {
      theme: THEMES.indexOf(p.theme) >= 0 ? p.theme : DEFAULT.theme,
      accent: /^#[0-9a-fA-F]{6}$/.test(p.accent || '') ? p.accent.toLowerCase() : DEFAULT.accent,
      wallpaper: WALLS.indexOf(p.wallpaper) >= 0 ? p.wallpaper : DEFAULT.wallpaper,
      textSize: SIZES.indexOf(p.textSize) >= 0 ? p.textSize : DEFAULT.textSize,
    };
  }

  function read() {
    try { return clean(JSON.parse(localStorage.getItem(KEY) || '{}')); } catch (e) { return clean({}); }
  }

  // Texte blanc ou foncé sur la couleur choisie ? On prend celui qui se lit le mieux.
  function luminance(hex) {
    var n = parseInt(hex.slice(1), 16);
    var rgb = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map(function (v) {
      v /= 255;
      return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
    });
    return 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2];
  }
  function onAccent(hex) {
    var L = luminance(hex);
    var withWhite = 1.05 / (L + 0.05);
    var withDark = (L + 0.05) / (0.008 + 0.05);
    return withWhite >= withDark ? '#ffffff' : '#17142a';
  }

  var current = read();

  function apply(p) {
    var root = document.documentElement;
    var dark = p.theme === 'dark' || (p.theme === 'auto' && mq.matches);
    root.setAttribute('data-mode', dark ? 'dark' : 'light');
    root.setAttribute('data-wall', p.wallpaper);
    root.setAttribute('data-text', p.textSize);
    root.style.setProperty('--accent', p.accent);
    root.style.setProperty('--on-accent', onAccent(p.accent));
    var meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', dark ? '#0f0d18' : p.accent);
  }

  apply(current);
  var onChange = function () { if (current.theme === 'auto') apply(current); };
  if (mq.addEventListener) mq.addEventListener('change', onChange); else mq.addListener(onChange);

  window.PapoteTheme = {
    DEFAULT: DEFAULT,
    clean: clean,
    get: function () { return Object.assign({}, current); },
    isDark: function () { return document.documentElement.getAttribute('data-mode') === 'dark'; },
    // Change les préférences, les applique tout de suite et les garde dans ce navigateur
    set: function (p) {
      current = clean(Object.assign({}, current, p));
      try { localStorage.setItem(KEY, JSON.stringify(current)); } catch (e) {}
      apply(current);
      return Object.assign({}, current);
    },
  };
})();
