// Photos and videos for posts live in the editor's Google Drive, in one folder the calendar
// creates there. Each file is shared as "anyone with the link can view" so the calendar can show
// it to people who aren't signed in. The database keeps only the file's Drive link.
//
// Access uses Google's token client with the drive.file scope: the calendar can see and change
// only the files and folder it created, nothing else in the Drive.

import { GOOGLE_CLIENT_ID, EDITOR_EMAIL } from "./config.js";

const SCOPE = "https://www.googleapis.com/auth/drive.file";
const FOLDER_NAME = "Silencio content calendar";
const FOLDER_TAG = { key: "silencioCalendar", value: "assets" };
const API = "https://www.googleapis.com/drive/v3";

let token = null; // { value, expires }
let gis = null;
let client = null;  // Google's token client, made once the script has loaded
let pending = null; // { resolve, reject } for the access request in progress
let folderId = null;

function loadGis() {
  gis ??= new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = "https://accounts.google.com/gsi/client";
    s.onload = () => resolve(window.google.accounts.oauth2);
    s.onerror = () => { gis = null; reject(new Error("Couldn't load Google sign-in.")); };
    document.head.append(s);
  });
  return gis;
}

const settle = (fn, value) => {
  const p = pending;
  pending = null;
  p?.[fn](value);
};

// Loads Google's script and sets up the token client ahead of time, when the composer opens.
// The access popup then opens in the same moment as the click that asks for it; a popup opened
// after any waiting is blocked by the browser ("Failed to open popup window").
export function prepareDrive() {
  if (!GOOGLE_CLIENT_ID || client) return;
  loadGis().then((oauth2) => {
    client ??= oauth2.initTokenClient({
      client_id: GOOGLE_CLIENT_ID,
      scope: SCOPE,
      login_hint: EDITOR_EMAIL,
      hd: EDITOR_EMAIL.split("@")[1],
      callback: (r) => {
        if (r.error) return settle("reject", new Error(`Google Drive: ${r.error_description ?? r.error}`));
        token = { value: r.access_token, expires: Date.now() + Number(r.expires_in) * 1000 };
        settle("resolve");
      },
      error_callback: (e) => settle("reject", new Error(
        e.type === "popup_closed" ? "Drive access was cancelled."
          : e.type === "popup_failed_to_open" ? "Your browser blocked Google's window. Allow pop-ups for this site and save again."
            : `Google Drive: ${e.message ?? e.type}`)),
    });
  }).catch(() => {});
}

export const driveReady = () => Boolean(token && token.expires > Date.now() + 60_000);

// Asks for Drive access. Call it directly in a click handler, before anything is awaited.
export function connectDrive() {
  if (driveReady()) return Promise.resolve();
  if (!client) {
    prepareDrive();
    return Promise.reject(new Error("Google Drive is still loading. Save again in a moment."));
  }
  const request = new Promise((resolve, reject) => { pending = { resolve, reject }; });
  client.requestAccessToken({ prompt: "" });
  return request;
}

async function call(url, init = {}) {
  if (!driveReady()) throw new Error("Connect Google Drive first.");
  const res = await fetch(url, { ...init, headers: { Authorization: `Bearer ${token.value}`, ...init.headers } });
  if (!res.ok) {
    let msg = `${res.status}`;
    try { msg = (await res.json()).error?.message ?? msg; } catch { /* keep the status */ }
    throw new Error(`Google Drive: ${msg}`);
  }
  return res;
}

const json = { "Content-Type": "application/json" };

async function folder() {
  if (folderId) return folderId;
  const q = `appProperties has { key='${FOLDER_TAG.key}' and value='${FOLDER_TAG.value}' } and mimeType='application/vnd.google-apps.folder' and trashed=false`;
  const found = await (await call(`${API}/files?q=${encodeURIComponent(q)}&fields=files(id)&pageSize=1`)).json();
  if (found.files.length) return (folderId = found.files[0].id);
  const made = await (await call(`${API}/files?fields=id`, {
    method: "POST",
    headers: json,
    body: JSON.stringify({ name: FOLDER_NAME, mimeType: "application/vnd.google-apps.folder", appProperties: { [FOLDER_TAG.key]: FOLDER_TAG.value } }),
  })).json();
  return (folderId = made.id);
}

// Uploads a file into the calendar's folder, shares it by link and returns its Drive link.
export async function uploadToDrive(file) {
  const parent = await folder();
  const start = await call("https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&fields=id", {
    method: "POST",
    headers: { ...json, "X-Upload-Content-Type": file.type || "application/octet-stream" },
    body: JSON.stringify({ name: file.name, parents: [parent] }),
  });
  const { id } = await (await call(start.headers.get("Location"), { method: "PUT", body: file })).json();
  try {
    await call(`${API}/files/${id}/permissions`, { method: "POST", headers: json, body: JSON.stringify({ role: "reader", type: "anyone" }) });
  } catch (err) {
    throw new Error(`${file.name} is in Drive, but it couldn't be shared by link, so only signed-in Silencio accounts will see it (${err.message}).`);
  }
  return `https://drive.google.com/file/d/${id}/view`;
}

// Moves a file the calendar uploaded to the Drive trash, where it can still be restored.
export async function trashInDrive(url) {
  const id = driveId(url);
  if (id && driveReady()) await call(`${API}/files/${id}`, { method: "PATCH", headers: json, body: JSON.stringify({ trashed: true }) });
}

export function driveId(url) {
  return /drive\.google\.com\/(?:file\/d\/|open\?id=|uc\?(?:.*&)?id=)([\w-]{10,})/.exec(url ?? "")?.[1] ?? null;
}

// Links that work for anyone the file is shared with, signed in or not.
export const drive = {
  image: (id) => `https://drive.google.com/thumbnail?id=${id}&sz=w1600`,
  player: (id) => `https://drive.google.com/file/d/${id}/preview`,
  download: (id) => `https://drive.google.com/uc?export=download&id=${id}`,
};
