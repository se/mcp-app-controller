import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App'

// CSS Custom Highlight API styling for the log-search matches. Injected at runtime
// because the CSS optimizer (lightningcss) doesn't recognize ::highlight() yet and
// warned on every build when these rules lived in index.css.
const highlightStyles = document.createElement('style')
highlightStyles.textContent = `
::highlight(log-match) { background-color: rgb(250 204 21 / 0.35); }
::highlight(log-match-current) { background-color: rgb(250 204 21); color: black; }
`
document.head.appendChild(highlightStyles)

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>
)
