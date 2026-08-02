# ClickPrint Desktop App

[![Electron](https://img.shields.io/badge/Electron-33.3.1-47848F?logo=electron&logoColor=white)](https://www.electronjs.org/)
[![React](https://img.shields.io/badge/React-18.3.1-61DAFB?logo=react&logoColor=black)](https://react.dev/)
[![Vite](https://img.shields.io/badge/Vite-6.0.7-646CFF?logo=vite&logoColor=white)](https://vite.dev/)
[![Platform](https://img.shields.io/badge/platform-windows%20%7C%20macos%20%7C%20linux-lightgrey)](#)

An Electron-based desktop client for **ClickPrint**—an automated, zero-intervention print management system designed for print shops and businesses. The desktop app connects to the ClickPrint server, downloads print jobs in real-time, routes them to designated local printers, and manages print queues automatically.

---

## 🚀 Key Features

*   **Zero-Interference Printing (Auto-Print)**: Automatically fetches, downloads, and outputs print jobs directly to physical printers based on predefined service routing, without requiring manual clicks.
*   **Real-Time Syncing (SSE)**: Powered by Server-Sent Events (SSE) for instant synchronization of new print jobs, status changes, and network diagnostics.
*   **Intelligent Print Engine**:
    *   Stateful queue management and local spooler tracking.
    *   Smooth pause/resume functionality for maintenance or paper refills.
    *   Smart print load balancing across multiple active printers.
    *   Manual overrides for individual file printing, job declination, or custom routing.
*   **Offline Resilience**:
    *   Background watcher polling printer availability via PowerShell (WMI) to avoid blocking the main thread.
    *   Autoroutable fallback mechanism when a designated printer goes offline.
    *   Isolated local download manager ensuring files are fully buffered before attempting print commands.
*   **Printer & Service Mapping**:
    *   Register physical local printers (both online and offline) to your ClickPrint shop.
    *   Configure print services (e.g., A4 Black/White, Color Glossy) and map them to physical hardware.
    *   Test print pages directly from the app interface (including custom HTML test page and print-to-PDF options).
*   **Seamless Updates**: Automatically checks, downloads, and applies application updates via GitHub releases.

---

## 🛠️ Tech Stack

*   **Shell/Runtime**: [Electron.js](https://www.electronjs.org/) (v33)
*   **Frontend**: [React](https://react.dev/) (v18), [Vite](https://vite.dev/) (v6), [React Router](https://reactrouter.com/) (v7)
*   **State & Storage**: [Electron Store](https://github.com/sindresorhus/electron-store) (persistent configuration, auth keys, and print progress)
*   **Styling**: Custom CSS with modern layouts, CSS variables, and responsive micro-animations
*   **System Tools**: PowerShell WMI querying for Windows hardware detection

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

*   [Node.js](https://nodejs.org/) (v18 or higher recommended)
*   [npm](https://www.npmjs.com/) (bundled with Node.js)
*   Windows OS (for full WMI printer features, though basic features work on macOS/Linux)

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
*   Vite dev server for the React renderer on port `3001`.
*   Electron main process pointing to `http://localhost:3001` (waits for renderer to be ready).

---

## 🔨 Build & Release

We use `electron-builder` to package and build installers for the application.

### Local Package Compilation

Build the React frontend and package the Electron app for your current OS:

```bash
# General build (depends on current host platform)
npm run build

# Windows Installer (.exe, Portable)
npm run build:win

# macOS App (.dmg, .zip)
npm run build:mac

# Linux App (.AppImage, .deb)
npm run build:linux
```

### Production Release (with auto-update publisher)

Ensure your `.env` contains the required GitHub authentication token (`GH_TOKEN`) or credentials, then publish:

```bash
# Release for Windows
npm run release-win

# Release for macOS
npm run release-mac
```

---

## 👥 Authors & Maintainers

*   **WeCode** - *Initial development & design* - [Website](https://wecode.com.pk/) - [support@wecode.com.pk](mailto:support@wecode.com.pk)
