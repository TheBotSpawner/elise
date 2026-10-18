/**
 * Unit tests never run inside Electron: "electron" resolves here, and each test mocks what it
 * needs (vi.mock("electron", …)). ELISE Desktop's own build uses the real module.
 */
export const app = {};
export const ipcMain = {};
export const safeStorage = {};
export const net = {};
export const shell = {};
export const session = {};
export const protocol = {};
export const autoUpdater = {};
