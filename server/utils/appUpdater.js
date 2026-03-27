const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');

const ROOT_PACKAGE_PATH = path.join(__dirname, '../../package.json');

const readJsonFileSafe = (filePath, fallback = {}) => {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    const raw = fs.readFileSync(filePath, 'utf-8');
    return JSON.parse(raw);
  } catch (e) {
    return fallback;
  }
};

const ROOT_PACKAGE = readJsonFileSafe(ROOT_PACKAGE_PATH, {});
const emitter = new EventEmitter();

let initialized = false;
let autoUpdater = null;
let electronApp = null;

const state = {
  appName:
    ROOT_PACKAGE?.build?.productName ||
    ROOT_PACKAGE?.name ||
    'terminalManage',
  currentVersion: String(ROOT_PACKAGE?.version || '0.0.0'),
  supported: false,
  enabled: false,
  checking: false,
  hasUpdate: false,
  downloaded: false,
  progress: 0,
  latestVersion: '',
  releaseName: '',
  releaseDate: '',
  status: 'idle',
  message: '',
  error: ''
};

const cloneState = () => ({ ...state });

const emitState = () => {
  emitter.emit('state', cloneState());
};

const updateState = (patch = {}) => {
  Object.assign(state, patch);
  emitState();
};

const setup = () => {
  if (initialized) return cloneState();
  initialized = true;

  const isElectronRuntime = Boolean(process.versions && process.versions.electron);
  if (!isElectronRuntime) {
    updateState({
      supported: false,
      enabled: false,
      status: 'disabled',
      message: 'Auto update is only available in Electron desktop app.'
    });
    return cloneState();
  }

  try {
    const { app } = require('electron');
    const updaterModule = require('electron-updater');
    electronApp = app;
    autoUpdater = updaterModule.autoUpdater;
  } catch (e) {
    updateState({
      supported: true,
      enabled: false,
      status: 'disabled',
      error: e.message || 'Failed to load electron-updater.',
      message: 'electron-updater is unavailable.'
    });
    return cloneState();
  }

  state.currentVersion = electronApp?.getVersion?.() || state.currentVersion;
  state.supported = true;
  state.enabled = !!electronApp?.isPackaged;

  if (!state.enabled) {
    updateState({
      status: 'disabled',
      message: 'Development mode does not support automatic download/install.'
    });
    return cloneState();
  }

  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;

  autoUpdater.on('checking-for-update', () => {
    updateState({
      checking: true,
      status: 'checking',
      error: '',
      message: 'Checking for updates...'
    });
  });

  autoUpdater.on('update-available', (info) => {
    updateState({
      checking: false,
      hasUpdate: true,
      downloaded: false,
      progress: 0,
      latestVersion: String(info?.version || ''),
      releaseName: String(info?.releaseName || ''),
      releaseDate: String(info?.releaseDate || ''),
      status: 'downloading',
      error: '',
      message: 'Update found. Downloading...'
    });
  });

  autoUpdater.on('update-not-available', () => {
    updateState({
      checking: false,
      hasUpdate: false,
      downloaded: false,
      progress: 0,
      latestVersion: '',
      releaseName: '',
      releaseDate: '',
      status: 'no-update',
      error: '',
      message: 'You are already on the latest version.'
    });
  });

  autoUpdater.on('download-progress', (progressObj) => {
    updateState({
      checking: false,
      hasUpdate: true,
      downloaded: false,
      progress: Number(progressObj?.percent || 0),
      status: 'downloading',
      error: '',
      message: 'Downloading update package...'
    });
  });

  autoUpdater.on('update-downloaded', (info) => {
    updateState({
      checking: false,
      hasUpdate: true,
      downloaded: true,
      progress: 100,
      latestVersion: String(info?.version || state.latestVersion || ''),
      releaseName: String(info?.releaseName || state.releaseName || ''),
      releaseDate: String(info?.releaseDate || state.releaseDate || ''),
      status: 'downloaded',
      error: '',
      message: 'Update downloaded. Restart to install.'
    });
  });

  autoUpdater.on('error', (err) => {
    updateState({
      checking: false,
      status: 'error',
      error: err?.message || String(err || 'unknown error'),
      message: 'Update failed.'
    });
  });

  updateState({
    status: 'idle',
    message: 'Ready to check updates.'
  });

  return cloneState();
};

const getState = () => {
  if (!initialized) setup();
  return cloneState();
};

const checkForUpdates = async () => {
  if (!initialized) setup();
  if (!state.enabled || !autoUpdater) {
    return {
      success: false,
      state: cloneState(),
      error: state.message || 'Auto update is unavailable in current mode.'
    };
  }
  if (state.checking) {
    return {
      success: true,
      state: cloneState(),
      message: 'Update check is already in progress.'
    };
  }

  try {
    await autoUpdater.checkForUpdates();
    return {
      success: true,
      state: cloneState()
    };
  } catch (e) {
    updateState({
      checking: false,
      status: 'error',
      error: e.message || 'checkForUpdates failed',
      message: 'Update check failed.'
    });
    return {
      success: false,
      state: cloneState(),
      error: state.error
    };
  }
};

const quitAndInstall = () => {
  if (!initialized) setup();
  if (!state.enabled || !autoUpdater) {
    return {
      success: false,
      state: cloneState(),
      error: state.message || 'Auto update is unavailable.'
    };
  }
  if (!state.downloaded) {
    return {
      success: false,
      state: cloneState(),
      error: 'Update package is not downloaded yet.'
    };
  }

  setImmediate(() => {
    autoUpdater.quitAndInstall();
  });

  return {
    success: true,
    state: cloneState()
  };
};

const onState = (listener) => {
  emitter.on('state', listener);
};

const offState = (listener) => {
  emitter.off('state', listener);
};

module.exports = {
  setup,
  getState,
  checkForUpdates,
  quitAndInstall,
  onState,
  offState
};

