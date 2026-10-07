import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { themeCss } from '@konsilium/tokens/theme';
import { App } from './App.tsx';
import './styles.css';

// Тема из дизайн-токенов. Акцент можно передать в адресе (?accent=0E7C6B) — так же его передаст хост через SDK.
const accent = new URLSearchParams(location.search).get('accent');
const style = document.createElement('style');
style.id = 'theme';
try {
  style.textContent = themeCss(accent ? `#${accent.replace(/^#/, '')}` : undefined);
} catch (e) {
  console.warn((e as Error).message);
  style.textContent = themeCss();
}
document.head.append(style);

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
