import React from 'react';
import ReactDOM from 'react-dom/client';
import { App } from './App';

const rootElement = document.getElementById('root');
if (!rootElement) {
  throw new Error('缺少 #root 挂载点');
}

ReactDOM.createRoot(rootElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
import './styles.css';
import './studio.css';
import './clinic.css';
import './coursePreparation.css';
import './finalPolish.css';
