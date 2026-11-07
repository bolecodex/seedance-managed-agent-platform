(() => {
  let theme = 'dark';
  try {
    theme = localStorage.getItem('visionary-theme') === 'light' ? 'light' : 'dark';
  } catch {}
  document.documentElement.dataset.theme = theme;
  const themeColor = document.querySelector('meta[name="theme-color"]');
  const colorScheme = document.querySelector('meta[name="color-scheme"]');
  if (themeColor) themeColor.content = theme === 'light' ? '#f4f6f2' : '#181917';
  if (colorScheme) colorScheme.content = theme;
})();
