import { $, browser } from "@wdio/globals";

export async function waitFor(check: () => Promise<boolean>, timeoutMsg: string): Promise<void> {
  await browser.waitUntil(check, { timeout: 12_000, interval: 150, timeoutMsg });
}

export async function openSettings(): Promise<string> {
  const mainWindow = await browser.getWindowHandle();
  await browser.executeObsidian(async ({ app }) => {
    const { setting } = app as unknown as { setting: {
      open(): Promise<void> | void;
      openTabById(id: string): Promise<void> | void;
    } };
    await setting.open();
    await setting.openTabById("langdock-sync");
  });
  const keyField = $('input[type="password"]');
  await waitFor(async () => {
    if (await keyField.isExisting()) return true;
    // Recent Obsidian versions open Settings in a separate window.
    const popup = (await browser.getWindowHandles()).find((handle) => handle !== mainWindow);
    if (popup && await browser.getWindowHandle() !== popup) await browser.switchToWindow(popup);
    return keyField.isExisting();
  }, "Langdock Sync settings did not open");
  return mainWindow;
}

export async function closeSettings(mainWindow: string): Promise<void> {
  if (await browser.getWindowHandle() === mainWindow) {
    await browser.keys("Escape");
  } else {
    await browser.closeWindow();
    await browser.switchToWindow(mainWindow);
  }
}
