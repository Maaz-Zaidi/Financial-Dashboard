const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
require('electron-reload')(__dirname);

function createWindow() {
  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true
    }
  });
  win.loadFile('renderer/index.html');
  win.webContents.openDevTools({ mode: 'detach' });
}

app.whenReady().then(createWindow);
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// IPC handler to invoke Python read
ipcMain.handle('load-csv', () => {
  const { spawnSync } = require('child_process');
  const py = spawnSync('python', ['csv_financial_extractor.py', '--read'], { encoding: 'utf-8' });
  return py.stdout;
});
