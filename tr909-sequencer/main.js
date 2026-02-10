const { app, BrowserWindow, ipcMain, dialog, session } = require('electron');
const path = require('path');
const fs = require('fs');

let mainWindow;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 1100,
    minHeight: 750,
    resizable: true,
    backgroundColor: '#1a1a1a',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      enableBlinkFeatures: 'WebMIDI'
    },
    icon: path.join(__dirname, 'assets', 'icon.png'),
    title: 'TR-909 Rhythm Composer'
  });

  mainWindow.loadFile(path.join(__dirname, 'src', 'index.html'));
  mainWindow.setMenuBarVisibility(false);

  // Uncomment for dev tools:
  // mainWindow.webContents.openDevTools();
}

app.whenReady().then(() => {
  session.defaultSession.setPermissionRequestHandler((webContents, permission, callback) => {
    if (permission === 'midi' || permission === 'midiSysex') {
      callback(true);
      return;
    }
    callback(false);
  });

  createWindow();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

// ─── IPC Handlers ───────────────────────────────────────────

// Load sample files from a directory
ipcMain.handle('load-samples-dir', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Select Samples Folder',
    properties: ['openDirectory']
  });
  if (result.canceled) return null;

  const dir = result.filePaths[0];
  const files = fs.readdirSync(dir)
    .filter(f => /\.(wav|mp3|ogg|flac)$/i.test(f))
    .map(f => ({
      name: f,
      path: path.join(dir, f),
      buffer: fs.readFileSync(path.join(dir, f))
    }));

  return files;
});

// Load a single sample file
ipcMain.handle('load-sample-file', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Select Sample',
    filters: [{ name: 'Audio', extensions: ['wav', 'mp3', 'ogg', 'flac'] }],
    properties: ['openFile']
  });
  if (result.canceled) return null;

  const filePath = result.filePaths[0];
  return {
    name: path.basename(filePath),
    path: filePath,
    buffer: fs.readFileSync(filePath)
  };
});


// Load sample file by absolute path (used for session restore)
ipcMain.handle('load-sample-path', async (event, samplePath) => {
  if (!samplePath) return null;
  try {
    if (!fs.existsSync(samplePath)) return null;
    return {
      name: path.basename(samplePath),
      path: samplePath,
      buffer: fs.readFileSync(samplePath)
    };
  } catch (err) {
    console.error('[909] Failed to load sample path:', samplePath, err);
    return null;
  }
});

// Save pattern to JSON
ipcMain.handle('save-pattern', async (event, patternData) => {
  const result = await dialog.showSaveDialog(mainWindow, {
    title: 'Save Pattern',
    defaultPath: 'pattern.909',
    filters: [{ name: 'TR-909 Pattern', extensions: ['909'] }]
  });
  if (result.canceled) return false;

  fs.writeFileSync(result.filePath, JSON.stringify(patternData, null, 2));
  return true;
});

// Load pattern from JSON
ipcMain.handle('load-pattern', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Load Pattern',
    filters: [{ name: 'TR-909 Pattern', extensions: ['909'] }],
    properties: ['openFile']
  });
  if (result.canceled) return null;

  const data = fs.readFileSync(result.filePaths[0], 'utf-8');
  return JSON.parse(data);
});
