import React, { useState, useEffect, useMemo, useRef } from "react";
import {
  Search,
  Lock,
  Unlock,
  Settings as SettingsIcon,
  Plus,
  Pencil,
  Trash2,
  X,
  Check,
  Loader2,
  AlertCircle,
  FolderSearch,
  LogIn,
  Download,
  ExternalLink,
  ChevronDown,
  RefreshCw,
} from "lucide-react";
import * as XLSX from "xlsx";
import seedRecords from "./data/seedRecords.json";

// ---------------------------------------------------------------------------
// Design tokens — consistent with the AQ Correspondence Studio look
// ---------------------------------------------------------------------------
const ink = "#1B2A44";
const brass = "#A9803F";
const brassLight = "#C9A15E";
const parchment = "#F7F2E7";
const charcoal = "#2A2823";
const slate = "#5B6472";
const slateLight = "#8B93A0";
const maroon = "#7B3131";
const line = "#D8CDB2";
const green = "#3E7D52";

const fontImport = `@import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap');`;

const REGISTRY_FILENAME = "ATL_Filing_Registry.json";
const DRIVE_SCOPE = "https://www.googleapis.com/auth/drive";

// ---------------------------------------------------------------------------
// Settings (localStorage) — Google Client ID + Admin PIN hash
// ---------------------------------------------------------------------------
const LS_SETTINGS_KEY = "atlfr:settings";

function loadSettings() {
  try {
    const raw = localStorage.getItem(LS_SETTINGS_KEY);
    return raw ? { googleClientId: "", adminPinHash: "", ...JSON.parse(raw) } : { googleClientId: "", adminPinHash: "" };
  } catch (e) {
    return { googleClientId: "", adminPinHash: "" };
  }
}
function saveSettings(s) {
  try {
    localStorage.setItem(LS_SETTINGS_KEY, JSON.stringify(s));
  } catch (e) {
    // ignore
  }
}

// Simple non-cryptographic hash — enough to deter casual edits by
// well-intentioned staff, NOT real security (this is a static frontend app,
// so nothing client-side can be truly tamper-proof).
function simpleHash(str) {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = (hash << 5) - hash + str.charCodeAt(i);
    hash |= 0;
  }
  return hash.toString(36);
}

// ---------------------------------------------------------------------------
// Google Identity Services loader + OAuth hook (same pattern as AQ Studio)
// ---------------------------------------------------------------------------
function loadGoogleIdentityScript() {
  return new Promise((resolve, reject) => {
    if (window.google && window.google.accounts && window.google.accounts.oauth2) {
      resolve();
      return;
    }
    const existing = document.getElementById("google-identity-script");
    if (existing) {
      existing.addEventListener("load", () => resolve());
      existing.addEventListener("error", () => reject(new Error("Failed to load Google script")));
      return;
    }
    const script = document.createElement("script");
    script.id = "google-identity-script";
    script.src = "https://accounts.google.com/gsi/client";
    script.async = true;
    script.defer = true;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error("Failed to load Google script"));
    document.head.appendChild(script);
  });
}

function useGoogleDrive() {
  const settings = loadSettings();
  const clientId = settings.googleClientId || "";

  const [scriptReady, setScriptReady] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [accessToken, setAccessToken] = useState(null);
  const [connectError, setConnectError] = useState(null);
  const tokenClientRef = useRef(null);

  useEffect(() => {
    if (!clientId) return;
    loadGoogleIdentityScript()
      .then(() => setScriptReady(true))
      .catch(() => setConnectError("Couldn't load Google's sign-in script. Check your internet connection."));
  }, [clientId]);

  function connect() {
    if (!scriptReady || !window.google) {
      setConnectError("Google's sign-in script hasn't loaded yet — try again in a moment.");
      return;
    }
    setConnecting(true);
    setConnectError(null);
    try {
      if (!tokenClientRef.current) {
        tokenClientRef.current = window.google.accounts.oauth2.initTokenClient({
          client_id: clientId,
          scope: DRIVE_SCOPE,
          callback: (response) => {
            setConnecting(false);
            if (response && response.access_token) {
              setAccessToken(response.access_token);
            } else {
              setConnectError("Sign-in didn't return an access token. Please try again.");
            }
          },
          error_callback: () => {
            setConnecting(false);
            setConnectError("Sign-in was cancelled or failed.");
          },
        });
      }
      tokenClientRef.current.requestAccessToken();
    } catch (e) {
      setConnecting(false);
      setConnectError("Couldn't start Google sign-in. Check your Client ID in Settings.");
    }
  }

  return { clientId, accessToken, setAccessToken, connecting, connectError, scriptReady, connect };
}

// ---------------------------------------------------------------------------
// Drive helpers — find/read/write the shared registry JSON file
// ---------------------------------------------------------------------------
async function driveFindRegistryFile(accessToken) {
  const params = new URLSearchParams({
    q: `name = '${REGISTRY_FILENAME}' and trashed = false`,
    fields: "files(id,name,modifiedTime)",
    pageSize: "5",
  });
  const res = await fetch(`https://www.googleapis.com/drive/v3/files?${params.toString()}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) throw new Error(`Couldn't search Drive (${res.status})`);
  const data = await res.json();
  return (data.files && data.files[0]) || null;
}

async function driveReadFile(fileId, accessToken) {
  const res = await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) throw new Error(`Couldn't read registry file (${res.status})`);
  return await res.json();
}

async function driveCreateRegistryFile(records, accessToken) {
  const metadata = { name: REGISTRY_FILENAME, mimeType: "application/json" };
  const boundary = "-------atlfr" + Date.now();
  const body =
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n` +
    `--${boundary}\r\nContent-Type: application/json\r\n\r\n${JSON.stringify(records)}\r\n--${boundary}--`;
  const res = await fetch("https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart", {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": `multipart/related; boundary=${boundary}` },
    body,
  });
  if (!res.ok) throw new Error(`Couldn't create registry file (${res.status})`);
  return await res.json();
}

async function driveUpdateRegistryFile(fileId, records, accessToken) {
  const res = await fetch(`https://www.googleapis.com/upload/drive/v3/files/${fileId}?uploadType=media`, {
    method: "PATCH",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify(records),
  });
  if (!res.ok) throw new Error(`Couldn't save changes to Drive (${res.status})`);
  return await res.json();
}

// ---------------------------------------------------------------------------
// Blank record template
// ---------------------------------------------------------------------------
function blankRecord() {
  return {
    id: `new-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    clientNo: "",
    clientName: "",
    projectNo: "",
    projectName: "",
    fileCode: "",
    description: "",
    city: "",
    client: "",
    fileType: "",
    status: "",
    physicalLocation: "",
    networkPath: "",
    driveLink: "",
  };
}

export default function App() {
  const drive = useGoogleDrive();

  const [records, setRecords] = useState(seedRecords);
  const [dataSource, setDataSource] = useState("seed"); // "seed" | "drive"
  const [registryFileId, setRegistryFileId] = useState(null);
  const [loadingRegistry, setLoadingRegistry] = useState(false);
  const [registryError, setRegistryError] = useState(null);
  const [saving, setSaving] = useState(false);

  const [query, setQuery] = useState("");
  const [clientFilter, setClientFilter] = useState("");
  const [statusFilter, setStatusFilter] = useState("");

  const [isAdmin, setIsAdmin] = useState(false);
  const [showPinPrompt, setShowPinPrompt] = useState(false);
  const [pinInput, setPinInput] = useState("");
  const [pinError, setPinError] = useState(null);

  const [showSettings, setShowSettings] = useState(false);
  const [editingRecord, setEditingRecord] = useState(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState(null);

  const settings = loadSettings();
  const hasPin = !!settings.adminPinHash;

  // Once connected to Drive, try to load the shared registry file
  useEffect(() => {
    if (!drive.accessToken) return;
    (async () => {
      setLoadingRegistry(true);
      setRegistryError(null);
      try {
        const file = await driveFindRegistryFile(drive.accessToken);
        if (file) {
          const data = await driveReadFile(file.id, drive.accessToken);
          setRecords(Array.isArray(data) ? data : seedRecords);
          setRegistryFileId(file.id);
          setDataSource("drive");
        }
        // if no file exists yet, keep showing the seed data; an admin can
        // initialize the shared registry from the banner shown below.
      } catch (e) {
        setRegistryError(e.message || "Couldn't load the shared registry from Drive.");
      } finally {
        setLoadingRegistry(false);
      }
    })();
  }, [drive.accessToken]);

  async function persistRecords(nextRecords) {
    setRecords(nextRecords);
    if (dataSource !== "drive" || !registryFileId || !drive.accessToken) return;
    setSaving(true);
    try {
      await driveUpdateRegistryFile(registryFileId, nextRecords, drive.accessToken);
    } catch (e) {
      setRegistryError("Saved locally, but couldn't sync to Drive: " + (e.message || ""));
    } finally {
      setSaving(false);
    }
  }

  async function handleInitializeRegistry() {
    if (!drive.accessToken) return;
    setSaving(true);
    setRegistryError(null);
    try {
      const file = await driveCreateRegistryFile(records, drive.accessToken);
      setRegistryFileId(file.id);
      setDataSource("drive");
    } catch (e) {
      setRegistryError(e.message || "Couldn't create the shared registry file.");
    } finally {
      setSaving(false);
    }
  }

  function handleUnlockAdmin() {
    if (!hasPin) {
      // first-time setup — treat entered value as the new PIN
      if (pinInput.length < 4) {
        setPinError("Choose a PIN of at least 4 digits/characters.");
        return;
      }
      saveSettings({ ...settings, adminPinHash: simpleHash(pinInput) });
      setIsAdmin(true);
      setShowPinPrompt(false);
      setPinInput("");
      setPinError(null);
      return;
    }
    if (simpleHash(pinInput) === settings.adminPinHash) {
      setIsAdmin(true);
      setShowPinPrompt(false);
      setPinInput("");
      setPinError(null);
    } else {
      setPinError("Incorrect PIN.");
    }
  }

  function handleSaveRecord(record) {
    const exists = records.some((r) => r.id === record.id);
    const next = exists ? records.map((r) => (r.id === record.id ? record : r)) : [...records, record];
    persistRecords(next);
    setEditingRecord(null);
  }

  function handleDeleteRecord(id) {
    persistRecords(records.filter((r) => r.id !== id));
    setConfirmDeleteId(null);
  }

  function handleExportExcel() {
    const rows = records.map((r) => ({
      "Client No.": r.clientNo,
      "Client Name": r.clientName,
      "Project No.": r.projectNo,
      "Project Name": r.projectName,
      "File Code": r.fileCode,
      Description: r.description,
      City: r.city,
      Client: r.client,
      "File Type": r.fileType,
      Status: r.status,
      "Physical Location": r.physicalLocation,
      "Network Path": r.networkPath,
      "Softcopy / Drive Link": r.driveLink,
    }));
    const ws = XLSX.utils.json_to_sheet(rows);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Registry");
    XLSX.writeFile(wb, `ATL_Filing_Registry_${new Date().toISOString().slice(0, 10)}.xlsx`);
  }

  const clientOptions = useMemo(() => {
    const set = new Set(records.map((r) => r.clientName).filter(Boolean));
    return Array.from(set).sort();
  }, [records]);

  const statusOptions = useMemo(() => {
    const set = new Set(records.map((r) => r.status).filter(Boolean));
    return Array.from(set).sort();
  }, [records]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return records.filter((r) => {
      if (clientFilter && r.clientName !== clientFilter) return false;
      if (statusFilter && r.status !== statusFilter) return false;
      if (!q) return true;
      const haystack = [
        r.clientName,
        r.projectName,
        r.description,
        r.city,
        r.client,
        r.fileType,
        r.status,
        r.physicalLocation,
        r.fileCode,
      ]
        .join(" ")
        .toLowerCase();
      return haystack.includes(q);
    });
  }, [records, query, clientFilter, statusFilter]);

  return (
    <div style={{ backgroundColor: "#EDE8DC", minHeight: "100vh", fontFamily: "Inter" }}>
      <style>{fontImport}</style>

      {/* Top bar */}
      <div style={{ backgroundColor: ink }} className="sticky top-0 z-20 shadow-md">
        <div className="mx-auto flex max-w-7xl flex-wrap items-center justify-between gap-3 px-6 py-4">
          <div className="flex items-center gap-2.5">
            <div className="flex h-8 w-8 items-center justify-center rounded-sm border font-bold text-white" style={{ borderColor: brassLight, fontSize: "11px" }}>
              ATL
            </div>
            <div>
              <div className="text-white" style={{ fontSize: "15px", fontWeight: 600 }}>
                Filing Registry
              </div>
              <div style={{ color: "#9FADC4", fontSize: "10.5px" }}>
                {dataSource === "drive" ? "Live shared registry" : "Local reference copy"} · {records.length} records
              </div>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <button
              onClick={handleExportExcel}
              className="flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-xs font-medium text-white"
              style={{ borderColor: "#33455F" }}
            >
              <Download size={13} /> Export Excel
            </button>
            {isAdmin ? (
              <button
                onClick={() => setIsAdmin(false)}
                className="flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-xs font-medium"
                style={{ borderColor: green, color: green, backgroundColor: "#EAF6EE" }}
              >
                <Unlock size={13} /> Admin mode
              </button>
            ) : (
              <button
                onClick={() => setShowPinPrompt(true)}
                className="flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-xs font-medium"
                style={{ borderColor: "#33455F", color: "#C7CEDB" }}
              >
                <Lock size={13} /> Admin
              </button>
            )}
            <button onClick={() => setShowSettings(true)} style={{ color: "#C7CEDB" }} title="Settings">
              <SettingsIcon size={18} />
            </button>
          </div>
        </div>
      </div>

      {/* Drive connection banner */}
      <div className="mx-auto max-w-7xl px-6 pt-4">
        {!drive.clientId ? (
          <div className="mb-4 rounded-lg border border-dashed p-3 text-center" style={{ borderColor: line, color: slate, fontSize: "12.5px" }}>
            Add a Google OAuth Client ID in Settings to connect the shared registry. Until then, you're viewing a local
            reference copy of the filing list — searchable, but not synced with the office's live copy.
          </div>
        ) : !drive.accessToken ? (
          <div className="mb-4 flex flex-wrap items-center justify-between gap-2 rounded-lg border p-3" style={{ borderColor: brass, backgroundColor: "#FBF3E4" }}>
            <span style={{ color: brass, fontSize: "12.5px" }}>Connect Google Drive to load and sync the live shared registry.</span>
            <button
              onClick={drive.connect}
              disabled={drive.connecting}
              className="flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-semibold text-white"
              style={{ backgroundColor: ink, opacity: drive.connecting ? 0.7 : 1 }}
            >
              {drive.connecting ? <Loader2 size={13} className="animate-spin" /> : <LogIn size={13} />}
              {drive.connecting ? "Connecting..." : "Connect Google Drive"}
            </button>
          </div>
        ) : loadingRegistry ? (
          <div className="mb-4 flex items-center gap-2 rounded-lg border p-3" style={{ borderColor: line, color: slate, fontSize: "12.5px" }}>
            <Loader2 size={14} className="animate-spin" /> Loading shared registry from Drive...
          </div>
        ) : dataSource !== "drive" ? (
          <div className="mb-4 flex flex-wrap items-center justify-between gap-2 rounded-lg border p-3" style={{ borderColor: brass, backgroundColor: "#FBF3E4" }}>
            <span style={{ color: brass, fontSize: "12.5px" }}>
              No shared registry file found in Drive yet — currently showing the local reference copy.
              {isAdmin ? " As admin, you can initialize it now:" : " Ask an admin to initialize it."}
            </span>
            {isAdmin && (
              <button
                onClick={handleInitializeRegistry}
                disabled={saving}
                className="flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-semibold text-white"
                style={{ backgroundColor: ink, opacity: saving ? 0.7 : 1 }}
              >
                {saving ? <Loader2 size={13} className="animate-spin" /> : <FolderSearch size={13} />}
                Initialize registry in Drive
              </button>
            )}
          </div>
        ) : (
          <div className="mb-4 flex items-center gap-2 rounded-lg border p-2.5" style={{ borderColor: "#BFE3CB", backgroundColor: "#EAF6EE", color: green, fontSize: "12px" }}>
            <Check size={14} /> Connected — this is the live shared registry.
            {saving && (
              <span className="flex items-center gap-1" style={{ color: brass }}>
                <Loader2 size={12} className="animate-spin" /> Saving...
              </span>
            )}
          </div>
        )}
        {registryError && (
          <div className="mb-4 flex items-center gap-1.5 rounded-md border px-3 py-2" style={{ borderColor: maroon, color: maroon, fontSize: "12px" }}>
            <AlertCircle size={13} /> {registryError}
          </div>
        )}
      </div>

      {/* Search + filters */}
      <div className="mx-auto max-w-7xl px-6">
        <div className="mb-4 flex flex-wrap gap-2">
          <div className="relative flex-1" style={{ minWidth: "220px" }}>
            <Search size={15} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2" style={{ color: slateLight }} />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search by client, project, description, location..."
              className="w-full rounded-md border py-2.5 pl-9 pr-3 text-sm outline-none"
              style={{ borderColor: line, backgroundColor: "white" }}
            />
          </div>
          <select
            value={clientFilter}
            onChange={(e) => setClientFilter(e.target.value)}
            className="rounded-md border px-3 py-2 text-sm"
            style={{ borderColor: line, backgroundColor: "white", color: charcoal, maxWidth: "220px" }}
          >
            <option value="">All clients</option>
            {clientOptions.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
          <select
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value)}
            className="rounded-md border px-3 py-2 text-sm"
            style={{ borderColor: line, backgroundColor: "white", color: charcoal, maxWidth: "180px" }}
          >
            <option value="">All statuses</option>
            {statusOptions.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
          {isAdmin && (
            <button
              onClick={() => setEditingRecord(blankRecord())}
              className="flex items-center gap-1.5 rounded-md px-3.5 py-2 text-sm font-medium text-white"
              style={{ backgroundColor: ink }}
            >
              <Plus size={15} /> Add Record
            </button>
          )}
        </div>

        <div style={{ color: slateLight, fontSize: "12px", marginBottom: "8px" }}>
          {filtered.length} of {records.length} records
        </div>

        {/* Results table */}
        <div className="overflow-x-auto rounded-lg border bg-white shadow-sm" style={{ borderColor: line }}>
          <table className="w-full text-xs" style={{ borderCollapse: "collapse" }}>
            <thead>
              <tr style={{ backgroundColor: ink }}>
                <th className="px-3 py-2 text-left" style={{ color: "white" }}>Client</th>
                <th className="px-3 py-2 text-left" style={{ color: "white" }}>Project</th>
                <th className="px-3 py-2 text-left" style={{ color: "white" }}>Description</th>
                <th className="px-3 py-2 text-left" style={{ color: "white" }}>Status</th>
                <th className="px-3 py-2 text-left" style={{ color: "white" }}>Physical Location</th>
                <th className="px-3 py-2 text-left" style={{ color: "white" }}>Softcopy</th>
                {isAdmin && <th className="px-3 py-2 text-left" style={{ color: "white" }}></th>}
              </tr>
            </thead>
            <tbody>
              {filtered.slice(0, 300).map((r, i) => (
                <tr key={r.id} style={{ backgroundColor: i % 2 === 0 ? "white" : "#FAFAF8", borderBottom: `1px solid ${line}` }}>
                  <td className="px-3 py-2 align-top" style={{ color: charcoal, maxWidth: "160px" }}>{r.clientName}</td>
                  <td className="px-3 py-2 align-top" style={{ color: slateLight, maxWidth: "160px" }}>{r.projectName}</td>
                  <td className="px-3 py-2 align-top" style={{ color: charcoal, minWidth: "220px" }}>{r.description}</td>
                  <td className="px-3 py-2 align-top" style={{ color: slateLight }}>{r.status}</td>
                  <td className="px-3 py-2 align-top" style={{ color: slateLight }}>{r.physicalLocation}</td>
                  <td className="px-3 py-2 align-top">
                    {r.driveLink ? (
                      <a href={r.driveLink} target="_blank" rel="noreferrer" className="flex items-center gap-1" style={{ color: brass }}>
                        <ExternalLink size={12} /> Open
                      </a>
                    ) : (
                      <span style={{ color: slateLight }}>—</span>
                    )}
                  </td>
                  {isAdmin && (
                    <td className="px-3 py-2 align-top">
                      <div className="flex gap-1.5">
                        <button onClick={() => setEditingRecord(r)} style={{ color: slate }} title="Edit">
                          <Pencil size={13} />
                        </button>
                        <button onClick={() => setConfirmDeleteId(r.id)} style={{ color: maroon }} title="Delete">
                          <Trash2 size={13} />
                        </button>
                      </div>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
          {filtered.length > 300 && (
            <div className="p-3 text-center" style={{ color: slateLight, fontSize: "11.5px" }}>
              Showing first 300 of {filtered.length} matches — narrow your search to see more precisely.
            </div>
          )}
          {filtered.length === 0 && (
            <div className="p-8 text-center" style={{ color: slateLight, fontSize: "13px" }}>
              No records match your search.
            </div>
          )}
        </div>
      </div>

      <div style={{ height: "40px" }} />

      {/* Admin PIN modal */}
      {showPinPrompt && (
        <div className="fixed inset-0 z-30 flex items-center justify-center bg-black/40 p-4" onClick={() => setShowPinPrompt(false)}>
          <div className="w-full max-w-xs rounded-lg bg-white p-5 shadow-xl" onClick={(e) => e.stopPropagation()}>
            <h3 style={{ color: ink, fontWeight: 700, fontSize: "15px", marginBottom: "10px" }}>
              {hasPin ? "Enter Admin PIN" : "Set an Admin PIN"}
            </h3>
            {!hasPin && (
              <p style={{ color: slateLight, fontSize: "11.5px", marginBottom: "8px" }}>
                No PIN is set yet — whatever you enter now becomes the admin PIN going forward.
              </p>
            )}
            <input
              type="password"
              value={pinInput}
              onChange={(e) => setPinInput(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && handleUnlockAdmin()}
              placeholder="PIN"
              autoFocus
              className="w-full rounded-md border px-3 py-2 text-sm outline-none"
              style={{ borderColor: line, fontFamily: "JetBrains Mono" }}
            />
            {pinError && (
              <div className="mt-2 flex items-center gap-1" style={{ color: maroon, fontSize: "11.5px" }}>
                <AlertCircle size={12} /> {pinError}
              </div>
            )}
            <div className="mt-4 flex justify-end gap-2">
              <button onClick={() => setShowPinPrompt(false)} className="rounded-md px-3 py-1.5 text-sm" style={{ color: slate }}>
                Cancel
              </button>
              <button onClick={handleUnlockAdmin} className="rounded-md px-4 py-1.5 text-sm font-medium text-white" style={{ backgroundColor: ink }}>
                {hasPin ? "Unlock" : "Set PIN"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Delete confirmation */}
      {confirmDeleteId && (
        <div className="fixed inset-0 z-30 flex items-center justify-center bg-black/40 p-4" onClick={() => setConfirmDeleteId(null)}>
          <div className="w-full max-w-xs rounded-lg bg-white p-5 shadow-xl" onClick={(e) => e.stopPropagation()}>
            <h3 style={{ color: ink, fontWeight: 700, fontSize: "15px", marginBottom: "8px" }}>Delete this record?</h3>
            <p style={{ color: slate, fontSize: "12.5px", marginBottom: "16px" }}>This can't be undone from within the app.</p>
            <div className="flex justify-end gap-2">
              <button onClick={() => setConfirmDeleteId(null)} className="rounded-md px-3 py-1.5 text-sm" style={{ color: slate }}>
                Cancel
              </button>
              <button
                onClick={() => handleDeleteRecord(confirmDeleteId)}
                className="rounded-md px-4 py-1.5 text-sm font-medium text-white"
                style={{ backgroundColor: maroon }}
              >
                Delete
              </button>
            </div>
          </div>
        </div>
      )}

      {editingRecord && <RecordEditModal record={editingRecord} onClose={() => setEditingRecord(null)} onSave={handleSaveRecord} />}
      {showSettings && <SettingsModal onClose={() => setShowSettings(false)} />}
    </div>
  );
}

function Field({ label, value, onChange, placeholder }) {
  return (
    <div>
      <label style={{ color: slate, fontSize: "11.5px", fontWeight: 500 }}>{label}</label>
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="mt-1 w-full rounded-md border px-3 py-2 text-sm outline-none"
        style={{ borderColor: line }}
      />
    </div>
  );
}

function RecordEditModal({ record, onClose, onSave }) {
  const [form, setForm] = useState({ ...record });

  function set(key) {
    return (value) => setForm((prev) => ({ ...prev, [key]: value }));
  }

  return (
    <div className="fixed inset-0 z-30 flex items-center justify-center bg-black/40 p-4" onClick={onClose}>
      <div className="max-h-[85vh] w-full max-w-lg overflow-y-auto rounded-lg bg-white p-5 shadow-xl" onClick={(e) => e.stopPropagation()}>
        <div className="mb-4 flex items-center justify-between">
          <h3 style={{ color: ink, fontWeight: 700, fontSize: "15px" }}>{record.description ? "Edit Record" : "Add Record"}</h3>
          <button onClick={onClose} style={{ color: slateLight }}>
            <X size={18} />
          </button>
        </div>
        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <Field label="Client No." value={form.clientNo} onChange={set("clientNo")} placeholder="e.g. 8" />
            <Field label="Client Name" value={form.clientName} onChange={set("clientName")} placeholder="e.g. PARCO" />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Project No." value={form.projectNo} onChange={set("projectNo")} placeholder="e.g. 8.2" />
            <Field label="Project Name" value={form.projectName} onChange={set("projectName")} placeholder="e.g. MOGAS MFM Phase I" />
          </div>
          <Field label="Description" value={form.description} onChange={set("description")} placeholder="File / document description" />
          <div className="grid grid-cols-3 gap-3">
            <Field label="City" value={form.city} onChange={set("city")} placeholder="" />
            <Field label="Client (short)" value={form.client} onChange={set("client")} placeholder="" />
            <Field label="File Type" value={form.fileType} onChange={set("fileType")} placeholder="e.g. Grey Box File" />
          </div>
          <Field label="Status" value={form.status} onChange={set("status")} placeholder="e.g. Completed, On Going" />
          <Field label="Physical Location" value={form.physicalLocation} onChange={set("physicalLocation")} placeholder="Cabinet / custody / rack" />
          <Field label="Network Path (optional)" value={form.networkPath} onChange={set("networkPath")} placeholder="\\\\server\\path\\..." />
          <Field label="Softcopy / Drive Link" value={form.driveLink} onChange={set("driveLink")} placeholder="https://drive.google.com/..." />
        </div>
        <div className="mt-5 flex justify-end gap-2">
          <button onClick={onClose} className="rounded-md px-3.5 py-2 text-sm" style={{ color: slate }}>
            Cancel
          </button>
          <button
            onClick={() => onSave(form)}
            className="flex items-center gap-1.5 rounded-md px-4 py-2 text-sm font-medium text-white"
            style={{ backgroundColor: ink }}
          >
            <Check size={14} /> Save
          </button>
        </div>
      </div>
    </div>
  );
}

function SettingsModal({ onClose }) {
  const initial = loadSettings();
  const [clientId, setClientId] = useState(initial.googleClientId || "");
  const [saved, setSaved] = useState(false);

  function handleSave() {
    saveSettings({ ...initial, googleClientId: clientId.trim() });
    setSaved(true);
    setTimeout(() => {
      setSaved(false);
      onClose();
    }, 600);
  }

  return (
    <div className="fixed inset-0 z-30 flex items-center justify-center bg-black/40 p-4" onClick={onClose}>
      <div className="w-full max-w-md rounded-lg bg-white p-5 shadow-xl" onClick={(e) => e.stopPropagation()}>
        <div className="mb-4 flex items-center justify-between">
          <h3 style={{ color: ink, fontWeight: 700, fontSize: "15px" }}>Settings</h3>
          <button onClick={onClose} style={{ color: slateLight }}>
            <X size={18} />
          </button>
        </div>
        <label style={{ color: slate, fontSize: "11.5px", fontWeight: 500 }}>Google OAuth Client ID</label>
        <input
          value={clientId}
          onChange={(e) => setClientId(e.target.value)}
          placeholder="xxxxxxxx.apps.googleusercontent.com"
          className="mt-1 w-full rounded-md border px-3 py-2 text-sm outline-none"
          style={{ borderColor: line, fontFamily: "JetBrains Mono" }}
        />
        <p style={{ color: slateLight, fontSize: "11px", marginTop: "6px" }}>
          You can reuse the same Client ID from AQ Correspondence Studio — just add this app's URL as an additional
          Authorized JavaScript origin in the same Google Cloud OAuth client.
        </p>
        <div className="mt-5 flex justify-end gap-2">
          <button onClick={onClose} className="rounded-md px-3.5 py-2 text-sm" style={{ color: slate }}>
            Cancel
          </button>
          <button onClick={handleSave} className="flex items-center gap-1.5 rounded-md px-4 py-2 text-sm font-medium text-white" style={{ backgroundColor: ink }}>
            {saved ? <Check size={14} /> : null}
            {saved ? "Saved" : "Save"}
          </button>
        </div>
      </div>
    </div>
  );
}
