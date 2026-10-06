import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import './index.css';

// StrictMode 临时禁用：排查 PIXI/事件问题。修复后请改回 StrictMode
ReactDOM.createRoot(document.getElementById('root')!).render(
  <App />
);
