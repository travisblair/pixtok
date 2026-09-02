/* @refresh reload */
import { render } from 'solid-js/web'
import './index.css'
import App from './App.tsx'
import { installCrashTrap } from './crash-trap'

// Must precede render: catches errors thrown during the mount itself.
installCrashTrap()

const root = document.getElementById('root')

render(() => <App />, root!)
