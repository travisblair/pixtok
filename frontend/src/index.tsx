/* @refresh reload */
import { render } from 'solid-js/web'
import './index.css'
import App from './App.tsx'
import { installCrashTrap } from './crash-trap'
import { installTapTrace } from './tapTrace'

// Must precede render: catches errors thrown during the mount itself.
installCrashTrap()
// TEMPORARY (tap-warning saga): raw input-event capture for the journal.
installTapTrace()

const root = document.getElementById('root')

render(() => <App />, root!)
