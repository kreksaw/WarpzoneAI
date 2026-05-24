const SUPPORTED_LANGS = ['en', 'fr', 'ar', 'zh'];
const RTL_LANGS = ['ar'];
const STORAGE_KEY = 'wz_lang';
const THEME_KEY = 'wz_theme';
const SUPPORTED_THEMES = ['light', 'dark'];

const nav = document.getElementById('nav');
const navToggle = document.getElementById('nav-toggle');
const navLinks = document.getElementById('nav-links');
const langSwitcher = document.getElementById('lang-switcher');
const langButton = document.getElementById('lang-button');
const langMenu = document.getElementById('lang-menu');
const langCurrent = document.getElementById('lang-current');

window.addEventListener('scroll', () => {
  nav.classList.toggle('scrolled', window.scrollY > 40);
}, { passive: true });

navToggle.addEventListener('click', () => {
  const open = navLinks.classList.toggle('open');
  navToggle.setAttribute('aria-expanded', open);
});

navLinks.querySelectorAll('a').forEach(link => {
  link.addEventListener('click', () => {
    navLinks.classList.remove('open');
    navToggle.setAttribute('aria-expanded', 'false');
  });
});

const reveals = document.querySelectorAll('.reveal');
const observer = new IntersectionObserver(
  entries => {
    entries.forEach(entry => {
      if (entry.isIntersecting) {
        entry.target.classList.add('visible');
        observer.unobserve(entry.target);
      }
    });
  },
  { threshold: 0.12, rootMargin: '0px 0px -40px 0px' }
);
reveals.forEach(el => observer.observe(el));

document.querySelectorAll('a[href^="#"]').forEach(anchor => {
  anchor.addEventListener('click', e => {
    const id = anchor.getAttribute('href');
    if (id === '#') return;
    const target = document.querySelector(id);
    if (target) {
      e.preventDefault();
      target.scrollIntoView({ behavior: 'smooth' });
    }
  });
});

function detectInitialLang() {
  const stored = localStorage.getItem(STORAGE_KEY);
  if (stored && SUPPORTED_LANGS.includes(stored)) return stored;
  const browser = (navigator.language || 'en').slice(0, 2).toLowerCase();
  return SUPPORTED_LANGS.includes(browser) ? browser : 'en';
}

function applyLanguage(lang) {
  if (!SUPPORTED_LANGS.includes(lang)) lang = 'en';
  const dict = (window.WZ_I18N && window.WZ_I18N[lang]) || {};
  const isRTL = RTL_LANGS.includes(lang);

  document.documentElement.lang = lang;
  document.documentElement.dir = isRTL ? 'rtl' : 'ltr';
  document.body.classList.toggle('rtl', isRTL);
  document.body.dataset.lang = lang;

  document.querySelectorAll('[data-i18n]').forEach(el => {
    const key = el.getAttribute('data-i18n');
    if (dict[key] !== undefined) {
      if (el.tagName === 'TITLE') {
        el.textContent = dict[key];
      } else {
        el.innerHTML = dict[key];
      }
    }
  });

  document.querySelectorAll('*').forEach(el => {
    for (const attr of el.attributes) {
      if (attr.name.startsWith('data-i18n-attr-')) {
        const targetAttr = attr.name.replace('data-i18n-attr-', '');
        const key = attr.value;
        if (dict[key] !== undefined) {
          el.setAttribute(targetAttr, dict[key]);
        }
      }
    }
  });

  if (langCurrent) {
    langCurrent.textContent = lang.toUpperCase();
  }
  if (langMenu) {
    langMenu.querySelectorAll('li').forEach(li => {
      li.classList.toggle('active', li.dataset.lang === lang);
      li.setAttribute('aria-selected', li.dataset.lang === lang ? 'true' : 'false');
    });
  }

  localStorage.setItem(STORAGE_KEY, lang);
}

function closeLangMenu() {
  if (!langSwitcher) return;
  langSwitcher.classList.remove('open');
  langButton.setAttribute('aria-expanded', 'false');
}

if (langButton && langMenu && langSwitcher) {
  langButton.addEventListener('click', e => {
    e.stopPropagation();
    const open = langSwitcher.classList.toggle('open');
    langButton.setAttribute('aria-expanded', open ? 'true' : 'false');
  });

  langMenu.querySelectorAll('li').forEach(li => {
    li.addEventListener('click', () => {
      const lang = li.dataset.lang;
      applyLanguage(lang);
      closeLangMenu();
    });
  });

  document.addEventListener('click', e => {
    if (!langSwitcher.contains(e.target)) closeLangMenu();
  });

  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') closeLangMenu();
  });
}

function detectInitialTheme() {
  try {
    const stored = localStorage.getItem(THEME_KEY);
    if (stored && SUPPORTED_THEMES.includes(stored)) return stored;
  } catch (e) {}
  return 'dark';
}

function applyTheme(theme) {
  if (!SUPPORTED_THEMES.includes(theme)) theme = 'dark';
  document.documentElement.setAttribute('data-theme', theme);
  document.querySelectorAll('.theme-option').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.theme === theme);
    btn.setAttribute('aria-pressed', btn.dataset.theme === theme ? 'true' : 'false');
  });
  try { localStorage.setItem(THEME_KEY, theme); } catch (e) {}
  console.log('[Warpzone] Theme switched to:', theme);
}

document.addEventListener('click', e => {
  const btn = e.target.closest('.theme-option');
  if (btn && btn.dataset.theme) {
    e.preventDefault();
    applyTheme(btn.dataset.theme);
  }
});

applyTheme(detectInitialTheme());

applyLanguage(detectInitialLang());
