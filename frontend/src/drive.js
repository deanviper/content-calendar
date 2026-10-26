// Photos and videos for posts live in the editor's Google Drive, in one folder the calendar
// creates there. Each file is shared as "anyone with the link can view" so the calendar can show
// it to people who aren't signed in. The database keeps only the file's Drive link.
//
// Drive access comes with the editor's Google sign-in: Supabase asks Google for the drive.file
// scope, so the calendar can see and change only the files and folder it created, nothing else
// in the Drive. Google's access token lasts an hour; after that the editor signs in again, which
// is a normal page redirect rather than a popup a browser might block.

export const DRIVE_SCOPE = "https://www.googleapis.com/auth/drive.file";
const FOLDER_NAME = "Silencio content calendar";
const FOLDER_TAG = { key: "silencioCalendar", value: "assets" };
const API = "https://www.googleapis.com/drive/v3";
const KEY = "driveToken";

let folderId = null;

function token() {
  try { return JSON.parse(sessionStorage.getItem(KEY)); } catch { return null; }
}

// Raised when Drive needs a fresh Google sign-in: no token, an expired one, or one without
// Drive access (Supabase also keeps tokens from sign-ins that never asked for Drive).
export class DriveAccessError extends Error {}

// Called with the Google token a signed-in session carries. It is kept only if Google confirms it
// grants Drive access, with the expiry Google reports.
let checking = Promise.resolve();

export function rememberDriveToken(value) {
  if (token()?.value === value) return checking;
  return (checking = check(value));
}

async function check(value) {
  try {
    const res = await fetch(`https://www.googleapis.com/oauth2/v3/tokeninfo?access_token=${encodeURIComponent(value)}`);
    const info = res.ok ? await res.json() : null;
    if (!info?.scope?.split(" ").includes(DRIVE_SCOPE)) return forgetDriveToken();
    sessionStorage.setItem(KEY, JSON.stringify({ value, expires: Date.now() + Number(info.expires_in) * 1000 }));
  } catch {
    forgetDriveToken();
  }
}

export function forgetDriveToken() {
  try { sessionStorage.removeItem(KEY); } catch { /* nothing to forget */ }
}

export const driveReady = () => Boolean(token()?.expires > Date.now() + 60_000);

// Whether uploads can go ahead, once any token check in progress has finished.
export async function driveAccess() {
  await checking;
  return driveReady();
}

async function call(url, init = {}) {
  if (!driveReady()) throw new DriveAccessError("Google Drive access has run out.");
  const res = await fetch(url, { ...init, headers: { Authorization: `Bearer ${token().value}`, ...init.headers } });
  if (!res.ok) {
    let msg = `${res.status}`;
    try { msg = (await res.json()).error?.message ?? msg; } catch { /* keep the status */ }
    if (res.status === 401 || /insufficient.*scope/i.test(msg)) {
      forgetDriveToken();
      throw new DriveAccessError(`Google Drive: ${msg}`);
    }
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
