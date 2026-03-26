const { app, BrowserWindow, Menu, Tray, shell, dialog, ipcMain } = require('electron');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const http = require('http');

// ── Constants ──
const APP_NAME = 'M-Claw';
const DEFAULT_PORT = 18789;
const MAX_PORT = 18799;
const GATEWAY_STARTUP_TIMEOUT = 30000;

// ── Paths ──
const isDev = process.argv.includes('--dev');
const appRoot = isDev ? __dirname + '/..' : process.resourcesPath + '/..';
const resourcesPath = isDev
  ? path.join(__dirname, '..', 'resources')
  : path.join(process.resourcesPath, 'resources');

// OpenClaw core location
const openclawPath = isDev
  ? path.join(__dirname, '..', 'node_modules', 'openclaw')
  : path.join(process.resourcesPath, 'app', 'node_modules', 'openclaw');

const openclawEntry = path.join(openclawPath, 'openclaw.mjs');

// Bundled Node.js runtime (OpenClaw needs standalone Node, not Electron's)
function getNodeBin() {
  const platform = process.platform;
  const arch = process.arch;
  if (isDev) {
    const devNodeDir = path.join(__dirname, '..', 'resources', 'runtime', `node-${platform}-${arch}`);
    const devNodeBin = platform === 'win32'
      ? path.join(devNodeDir, 'node.exe')
      : path.join(devNodeDir, 'bin', 'node');
    if (fs.existsSync(devNodeBin)) return devNodeBin;
    return 'node';
  }
  const nodeDir = path.join(process.resourcesPath, 'resources', 'runtime', `node-${platform}-${arch}`);
  const nodeBin = platform === 'win32'
    ? path.join(nodeDir, 'node.exe')
    : path.join(nodeDir, 'bin', 'node');
  if (fs.existsSync(nodeBin)) return nodeBin;
  return 'node';
}

// Portable mode: if a `portable/` directory exists next to the .app bundle, use it for data
function getPortableDataPath() {
  const appPath = app.getAppPath(); // inside .app/Contents/Resources/app
  // Walk up to the .app's parent directory
  const appBundleDir = path.resolve(appPath, '..', '..', '..', '..');
  const portableDir = path.join(appBundleDir, 'portable');
  if (fs.existsSync(portableDir)) {
    console.log(`[${APP_NAME}] Portable mode: data in ${portableDir}`);
    return portableDir;
  }
  return null;
}

// User data — portable or default
const portablePath = app.isPackaged ? getPortableDataPath() : null;
const userDataPath = portablePath || app.getPath('userData');
const configDir = path.join(userDataPath, '.openclaw');
const configPath = path.join(configDir, 'openclaw.json');

// ── State ──
let mainWindow = null;
let tray = null;
let gatewayProcess = null;
let gatewayPort = DEFAULT_PORT;
let gatewayReady = false;
let configServerPort = null; // mini HTTP server for Config.html

// ── Config Management ──
function ensureConfig() {
  fs.mkdirSync(configDir, { recursive: true });
  fs.mkdirSync(path.join(userDataPath, 'memory'), { recursive: true });
  fs.mkdirSync(path.join(userDataPath, 'backups'), { recursive: true });

  if (!fs.existsSync(configPath)) {
    const defaultConfig = {
      gateway: {
        mode: 'local',
        auth: { token: 'uclaw' }
      }
    };
    fs.writeFileSync(configPath, JSON.stringify(defaultConfig, null, 2));
    console.log(`[${APP_NAME}] Created default config at ${configPath}`);
  }
}

function getConfig() {
  try {
    return JSON.parse(fs.readFileSync(configPath, 'utf8'));
  } catch {
    return { gateway: { mode: 'local', auth: { token: 'uclaw' } } };
  }
}

function hasModelConfigured() {
  const config = getConfig();
  // Check new format: agents.defaults.model.primary or env with API key or models.providers
  if (config.agents?.defaults?.model?.primary) return true;
  if (config.env && Object.keys(config.env).some(k => k.includes('API_KEY'))) return true;
  if (config.models?.providers && Object.keys(config.models.providers).length > 0) return true;
  // Legacy format
  if (config.agent?.model) return true;
  return false;
}

function getToken() {
  const config = getConfig();
  return config?.gateway?.auth?.token || 'uclaw';
}

// ── Port Detection ──
function isPortAvailable(port) {
  return new Promise((resolve) => {
    const server = require('net').createServer();
    server.once('error', () => resolve(false));
    server.once('listening', () => {
      server.close();
      resolve(true);
    });
    server.listen(port, '127.0.0.1');
  });
}

async function findAvailablePort() {
  for (let port = DEFAULT_PORT; port <= MAX_PORT; port++) {
    if (await isPortAvailable(port)) return port;
  }
  throw new Error(`No available port in range ${DEFAULT_PORT}-${MAX_PORT}`);
}

// ── Mini HTTP Server for Config.html ──
// Serves Config.html on localhost so WebSocket origin is http://127.0.0.1:xxx
// (OpenClaw gateway rejects non-http origins like file:// or custom protocols)
function startConfigServer() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const url = new URL(req.url, `http://${req.headers.host}`);

      // GET /api/config — return current config
      if (req.method === 'GET' && url.pathname === '/api/config') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(getConfig()));
        return;
      }

      // POST /api/config — save/merge config
      if (req.method === 'POST' && url.pathname === '/api/config') {
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', () => {
          try {
            const newConfig = JSON.parse(body);
            const existing = getConfig();
            const merged = Object.assign(existing, newConfig);
            fs.writeFileSync(configPath, JSON.stringify(merged, null, 2));
            console.log(`[${APP_NAME}] Config saved`);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: true }));
          } catch (e) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: e.message }));
          }
        });
        return;
      }

      // POST /api/done — config complete, load dashboard
      if (req.method === 'POST' && url.pathname === '/api/done') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
        // Switch to dashboard after short delay
        setTimeout(() => {
          if (mainWindow && gatewayReady) {
            const token = getToken();
            mainWindow.loadURL(`http://127.0.0.1:${gatewayPort}/#token=${token}`);
          }
        }, 500);
        return;
      }

      // Default: serve Config.html
      const configHtml = path.join(resourcesPath, 'Config.html');
      if (fs.existsSync(configHtml)) {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        fs.createReadStream(configHtml).pipe(res);
      } else {
        res.writeHead(404);
        res.end('Config.html not found');
      }
    });
    // Listen on random available port
    server.listen(0, '127.0.0.1', () => {
      configServerPort = server.address().port;
      console.log(`[${APP_NAME}] Config server on http://127.0.0.1:${configServerPort}`);
      resolve(configServerPort);
    });
  });
}

function getConfigURL() {
  return `http://127.0.0.1:${configServerPort}/?port=${gatewayPort}`;
}

// ── Gateway Management ──
function startGateway(port) {
  return new Promise((resolve, reject) => {
    console.log(`[${APP_NAME}] Starting OpenClaw gateway on port ${port}...`);

    const nodeBin = getNodeBin();
    console.log(`[${APP_NAME}] Using Node.js: ${nodeBin}`);

    const env = {
      ...process.env,
      OPENCLAW_HOME: userDataPath,
      OPENCLAW_STATE_DIR: configDir,
      OPENCLAW_CONFIG_PATH: configPath,
      OPENCLAW_EMBEDDED_IN: APP_NAME,
    };

    gatewayProcess = spawn(nodeBin, [
      openclawEntry,
      'gateway', 'run',
      '--allow-unconfigured',
      '--force',
      '--port', String(port),
    ], {
      env,
      cwd: openclawPath,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    gatewayProcess.stdout.on('data', (data) => {
      const msg = data.toString().trim();
      if (msg) console.log(`[OpenClaw] ${msg}`);
    });

    gatewayProcess.stderr.on('data', (data) => {
      const msg = data.toString().trim();
      if (msg) console.error(`[OpenClaw:err] ${msg}`);
    });

    gatewayProcess.on('error', (err) => {
      console.error(`[${APP_NAME}] Gateway process error:`, err);
      reject(err);
    });

    gatewayProcess.on('exit', (code) => {
      console.log(`[${APP_NAME}] Gateway exited with code ${code}`);
      gatewayProcess = null;
      gatewayReady = false;
    });

    // Poll for gateway readiness
    const startTime = Date.now();
    const checkReady = () => {
      if (Date.now() - startTime > GATEWAY_STARTUP_TIMEOUT) {
        reject(new Error('Gateway startup timeout'));
        return;
      }

      const req = http.get(`http://127.0.0.1:${port}/`, (res) => {
        gatewayReady = true;
        gatewayPort = port;
        console.log(`[${APP_NAME}] Gateway ready on port ${port}`);
        resolve(port);
      });
      req.on('error', () => setTimeout(checkReady, 500));
      req.setTimeout(2000, () => {
        req.destroy();
        setTimeout(checkReady, 500);
      });
    };

    setTimeout(checkReady, 1000);
  });
}

function stopGateway() {
  if (gatewayProcess) {
    console.log(`[${APP_NAME}] Stopping gateway...`);
    gatewayProcess.kill('SIGTERM');
    setTimeout(() => {
      if (gatewayProcess) gatewayProcess.kill('SIGKILL');
    }, 5000);
  }
}

// ── Window Management ──
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 800,
    minHeight: 600,
    title: APP_NAME,
    icon: path.join(__dirname, '..', 'assets', 'icon.png'),
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js'),
    },
    show: false,
    backgroundColor: '#0a0a0a',
  });

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  // Open external links in browser
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http')) shell.openExternal(url);
    return { action: 'deny' };
  });

  loadAppPage();
}

function loadAppPage() {
  if (!mainWindow) return;

  if (gatewayReady) {
    const token = getToken();
    mainWindow.loadURL(`http://127.0.0.1:${gatewayPort}/#token=${token}`);
  } else {
    const loadingHtml = path.join(__dirname, 'loading.html');
    mainWindow.loadFile(loadingHtml);
  }
}

function loadConfigPage() {
  if (!mainWindow || !gatewayReady || !configServerPort) return;
  mainWindow.loadURL(getConfigURL());
}

// ── Menu ──
function createMenu() {
  const template = [
    {
      label: APP_NAME,
      submenu: [
        { label: `About ${APP_NAME}`, role: 'about' },
        { type: 'separator' },
        {
          label: '配置助手 / Configuration',
          accelerator: 'CmdOrCtrl+,',
          click: () => loadConfigPage()
        },
        {
          label: 'Dashboard',
          accelerator: 'CmdOrCtrl+D',
          click: () => {
            if (mainWindow && gatewayReady) {
              const token = getToken();
              mainWindow.loadURL(`http://127.0.0.1:${gatewayPort}/#token=${token}`);
            }
          }
        },
        { type: 'separator' },
        {
          label: 'Open Data Folder',
          click: () => shell.openPath(userDataPath)
        },
        { type: 'separator' },
        { label: 'Quit', accelerator: 'CmdOrCtrl+Q', click: () => app.quit() }
      ]
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' }
      ]
    },
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        { role: 'forceReload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' }
      ]
    },
    {
      label: 'Help',
      submenu: [
        {
          label: 'Website',
          click: () => shell.openExternal('https://u-claw.org')
        },
        {
          label: 'WeChat: hecare888',
          click: () => {
            dialog.showMessageBox({ message: 'WeChat / 微信: hecare888', type: 'info' });
          }
        }
      ]
    }
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// ── IPC Handlers ──
function setupIPC() {
  ipcMain.handle('get-gateway-status', () => ({
    ready: gatewayReady,
    port: gatewayPort,
    token: getToken(),
    hasModel: hasModelConfigured(),
  }));

  ipcMain.handle('open-dashboard', () => {
    if (mainWindow && gatewayReady) {
      const token = getToken();
      mainWindow.loadURL(`http://127.0.0.1:${gatewayPort}/#token=${token}`);
    }
  });

  ipcMain.handle('open-config', () => loadConfigPage());
}

// ── App Lifecycle ──
app.whenReady().then(async () => {
  console.log(`[${APP_NAME}] v${app.getVersion()} starting...`);

  // Setup
  ensureConfig();
  createMenu();
  setupIPC();
  createWindow();

  // Start mini HTTP server for Config.html
  await startConfigServer();

  try {
    // Find port and start gateway
    const port = await findAvailablePort();
    await startGateway(port);

    // Gateway is ready — if no model configured, show Config.html first
    if (hasModelConfigured()) {
      loadAppPage();
    } else {
      console.log(`[${APP_NAME}] No model configured, opening Config.html`);
      loadConfigPage();
    }
  } catch (err) {
    console.error(`[${APP_NAME}] Failed to start gateway:`, err);
    dialog.showErrorBox(
      `${APP_NAME} - Startup Error`,
      `Failed to start OpenClaw gateway.\n\n${err.message}\n\nPlease check if Node.js is available and try again.`
    );
  }
});

app.on('window-all-closed', () => {
  stopGateway();
  app.quit();
});

app.on('before-quit', () => {
  stopGateway();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});
