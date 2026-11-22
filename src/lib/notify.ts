// System notification when the window isn't focused (the in-app marks cover the rest).
export async function notify(title: string, body: string) {
  if (document.hasFocus()) return;
  try {
    const n = await import("@tauri-apps/plugin-notification");
    let ok = await n.isPermissionGranted();
    if (!ok) ok = (await n.requestPermission()) === "granted";
    if (ok) n.sendNotification({ title, body });
  } catch {
    /* notifications unavailable */
  }
}
