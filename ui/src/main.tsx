import { createRoot } from 'react-dom/client';
import { App } from './App';
import { applyTheme, readTheme } from './theme';

applyTheme(readTheme()); // before the first paint, so a light theme never flashes dark

createRoot(document.getElementById('root')!).render(<App />);
