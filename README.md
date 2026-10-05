# ClickPrint Desktop App

[![Electron](https://img.shields.io/badge/Electron-33.3.1-47848F?logo=electron&logoColor=white)](https://www.electronjs.org/)
[![Platform](https://img.shields.io/badge/platform-windows)](#)

An Electron-based desktop client for **ClickPrint**—an automated, zero-intervention print management system designed for print shops and businesses. The desktop app connects to the ClickPrint server, downloads print jobs in real-time, routes them to designated local printers, and manages print queues automatically.

---

## 🚀 Key Features

- **Automatic Printing**
- **Real-Time Syncing (SSE)**
- **Intelligent Print Engine**:
     - Stateful queue management and local spooler tracking.
     - Load balancing across multiple active printers.
     - Manual overrides
- **Offline Resilience** (built for shops with unreliable internet):
     - Every backend call has a timeout; the app tracks whether the server is reachable and shows an offline banner.
     - Screens show the last saved copy of jobs, history, services, printers and the shop profile when the server can't be reached.
     - Downloads resume and retry until they succeed. A job is never failed (or refunded) because of the network.
     - Jobs already downloaded can be printed by hand while offline. Their status updates are queued and sent once the connection returns. Automated printing waits for the connection.
     - WhatsApp messages received during an outage are kept and handled once it's back, and replies wait until WhatsApp reconnects.
     - Background watcher polling printer availability via PowerShell (WMI) to avoid blocking the main thread.
- **Seamless Updates**: Automatically checks, downloads, and applies application updates via GitHub releases.

---

## 🛠️ Tech Stack

- **Shell/Runtime**: [Electron.js](https://www.electronjs.org/) (v33)
- **Frontend**: [React](https://react.dev/) (v18), [Vite](https://vite.dev/) (v6), [React Router](https://reactrouter.com/) (v7)
- **State & Storage**: [Electron Store](https://github.com/sindresorhus/electron-store) (persistent configuration, auth keys, and print progress)
- **System Tools**: PowerShell WMI querying for Windows hardware detection

---

## 📁 Repository Structure

```text
├── assets/                 # Shared static assets (icons, sounds) for both processes
│
├── main/                   # Electron main process code
│   ├── api.js              # ClickPrint REST API & SSE client integration
│   ├── files.js            # File download, cache & custom protocol registry
│   ├── ipc.js              # Inter-process communication handlers
│   ├── main.js             # Electron window setup & life cycle management
│   ├── preload.js          # Main-renderer security bridge/API exposing
│   ├── printEngine.js      # Core print orchestrator, state machine, & routing
│   ├── printerRegistry.js  # Spooler tracking and queue balancer
│   ├── printers.js         # Local hardware detection & offline watcher (PowerShell)
│   ├── spooler.js          # Print queue controller
│   ├── state.js            # App-wide main process state container
│   └── store.js            # Local configuration disk store
│
├── renderer/               # React frontend (Vite project)
│   ├── dist/               # Production build output
│   └── src/
│       ├── components/     # UI elements (buttons, inputs, cards)
│       ├── dashboard/      # Tabs, context providers, layout, and utils
│       ├── screens/        # Main route screens (Login, OTP, Shop Select, Dashboard)
│       └── styles/         # Styling system & utility declarations
│
├── scripts/                # Build and development orchestration scripts
└── package.json            # Scripts, dependencies, and electron-builder configs
```

---

## 📦 Getting Started

### Prerequisites

- [Node.js](https://nodejs.org/)
- [npm](https://www.npmjs.com/)

### Installation

1. Clone the repository:

      ```bash
      git clone https://github.com/WeCodePK/ClickPrintDesktop.git
      cd ClickPrintDesktop
      ```

2. Install dependencies:

      ```bash
      npm install
      ```

3. The backend address is fixed in `main/http.js` (`https://api.clickprint.pk`). A `.env` is only needed to publish releases (`npm run release`).

### Running Locally

To start the application in development mode with hot-reloading:

```bash
npm run dev
```

This launches:

- Vite dev server for the React renderer on port `3001`.
- Electron main process pointing to `http://localhost:3001` (waits for renderer to be ready).


### Testing a bad connection

To simulate a poor network in development, set `CLICKPRINT_NET_FAULT` before starting the app. It accepts `offline`, `flaky:0.5` (half of all requests fail), `latency:3000` (every request takes 3 s longer), or a combination such as `flaky:0.3,latency:2000`. It covers requests and file downloads from the ClickPrint server. The live jobs stream only honours `offline`. WhatsApp, and uploads of WhatsApp files, are not covered.

```bash
CLICKPRINT_NET_FAULT=flaky:0.5 npm run dev
```

From the renderer devtools you can also switch it at runtime with `window.electronAPI.setNetFault("offline")`, and turn it off with `""` (development builds only).

---

## 👥 [WeCode Team](https://wecode.com.pk)

- **[Abdul Ahad](https://github.com/ahad19n)**,
- **[Kamal Hassan](https://github.com/kamal-hassan-1)**,
- **[Sohail Khan](https://github.com/devSohailK)**
