const { app, BrowserWindow, ipcMain, Menu } = require('electron');
const path = require('path');
const fs = require('fs');

try {
  require('electron-reload')(__dirname, { electron: require('electron') });
} catch (e) {
  console.warn('Live reload disabled:', e.message);
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    autoHideMenuBar: true,
    backgroundColor: '#0f1115',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true
    }
  });
  win.webContents.openDevTools({ mode: 'detach' });

  win.removeMenu();

  win.loadFile('renderer/index.html');
}

app.whenReady().then(() => {
  Menu.setApplicationMenu(null);
  createWindow();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

ipcMain.handle('write-ignores', async (_evt, body) => {
  const base = app.getAppPath(); // or your repo root
  const cfgDir = path.join(base, 'Config');
  const file = path.join(cfgDir, 'ignores.txt');
  await fs.promises.mkdir(cfgDir, { recursive: true });
  await fs.promises.writeFile(file, body ?? '', 'utf-8');
  return true;
});


ipcMain.handle('load-csv', async () => {
  const { spawnSync } = require('child_process');
  const py = spawnSync('python', ['csv_financial_extractor.py', '--read'], {
    encoding: 'utf-8'
  });
  return py.stdout || '';
});
