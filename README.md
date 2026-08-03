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
- **Offline Resilience**:
     - Background watcher polling printer availability via PowerShell (WMI) to avoid blocking the main thread.
     - Autoroutable fallbacks
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
├── main/                   # Electron main process code
│   ├── assets/             # Main process assets (icons)
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
│   ├── public/             # Static assets
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

3. Setup environment variables:
   Create a `.env` file in the root directory (refer to `.env.example` if available) and add your environment configuration:
      ```env
      # Example variables
      API_BASE_URL=https://api.clickprint.com
      ```

### Running Locally

To start the application in development mode with hot-reloading:

```bash
npm run dev
```

This launches:

- Vite dev server for the React renderer on port `3001`.
- Electron main process pointing to `http://localhost:3001` (waits for renderer to be ready).

---

## 👥 Authors & Maintainers

- **[WeCode Team](https://wecode.com.pk)**
- https://github.com/kamal-hassan-1
- https://github.com/ahad19n
- https://github.com/devSohailK
