import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { MotionConfig } from 'framer-motion';
import App from './App';
import './phone.css';
import './styles.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <MotionConfig reducedMotion="user">
      <App />
    </MotionConfig>
  </StrictMode>,
);

// Open at #section links (the page is drawn after the browser would have scrolled).
if (location.hash) setTimeout(() => document.querySelector(location.hash)?.scrollIntoView(), 150);
