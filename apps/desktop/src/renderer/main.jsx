import { createRoot } from 'react-dom/client';
import './styles/tokens.css';
import './styles/app.css';
import App from './App.jsx';

// Diagnostic du viewport, activé par le mode capture.
window.TITI_DIAG = new URLSearchParams(location.search).has('diag') || location.hash === '#diag';

createRoot(document.getElementById('root')).render(<App />);
