import React from 'react';
import {createRoot} from 'react-dom/client';
import {Provider} from 'react-redux';
import {BrowserRouter} from 'react-router-dom';
import {store} from './store/index.js';
import {App} from './App.jsx';
import {installSessionSync} from './lib/session-events.js';
import '@fontsource/manrope/400.css';
import '@fontsource/manrope/500.css';
import '@fontsource/manrope/600.css';
import '@fontsource/manrope/700.css';
import '@fontsource/dm-sans/400.css';
import '@fontsource/dm-sans/500.css';
import './styles.css';

installSessionSync(store);
createRoot(document.getElementById('root')).render(<React.StrictMode><Provider store={store}><BrowserRouter><App /></BrowserRouter></Provider></React.StrictMode>);
