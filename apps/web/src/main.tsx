import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App.js'
import { createApiClient } from './api.js'
import './styles.css'

const root = document.getElementById('root')
if (!root) throw new Error('missing #root element')
createRoot(root).render(
  <StrictMode>
    <App client={createApiClient()} />
  </StrictMode>,
)
