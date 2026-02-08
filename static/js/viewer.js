/**
 * Three.js STEP viewer — CAD-style viewport
 * Top toolbar, console log, fading dot grid, pink selection, XYZ gizmo.
 */
import * as THREE from "three";
import { ArcballControls } from "three/addons/controls/ArcballControls.js";

/* ── DOM refs ───────────────────────────────────── */
const container = document.getElementById("viewer-container");
const fileInput = document.getElementById("file-input");
const uploadLabel = document.getElementById("upload-label");
const dropZone = document.getElementById("drop-zone");
const loading = document.getElementById("loading");
const exportSection = document.getElementById("export-section");
const exportBtn = document.getElementById("export-btn");
const gizmoContainer = document.getElementById("gizmo-container");
const modelUuidEl = document.getElementById("model-uuid");

/* Right panel */
const rightPanel = document.getElementById("right-panel");
const rpClose = document.getElementById("rp-close");
const rpFaceId = document.getElementById("rp-face-id");
const rpFaceType = document.getElementById("rp-face-type");
const rpFaceArea = document.getElementById("rp-face-area");
const colorPicker = document.getElementById("color-picker");
const resetColorBtn = document.getElementById("reset-color-btn");
const inpDatum = document.getElementById("inp-datum");

/* Toolbar buttons */
const tbEdges = document.getElementById("tb-edges");
const tbFit = document.getElementById("tb-fit");

/* ══════════════════════════════════════════════════
   CONSOLE LOG
   ══════════════════════════════════════════════════ */
const consoleEl = document.getElementById("console-log");

function clog(msg, level = "info") {
    const line = document.createElement("div");
    line.className = `log-line log-${level}`;
    const ts = new Date().toLocaleTimeString("en-GB", { hour12: false });
    line.innerHTML = `<span class="log-time">${ts}</span>${msg}`;
    consoleEl.appendChild(line);
    consoleEl.scrollTop = consoleEl.scrollHeight;
}

clog("Initializing...");

/* ══════════════════════════════════════════════════
   COMBOBOX
   ══════════════════════════════════════════════════ */
class Combobox {
    constructor(el, options = [], onChange = null) {
        if (!el) { console.error("Combobox: element not found"); return; }
        this.el = el; this.input = el.querySelector("input");
        if (!this.input) { console.error("Combobox: input not found in", el); return; }
        this.listEl = el.querySelector(".combobox-list");
        this.options = options; this.onChange = onChange; this.activeIdx = -1;
        /* Clear button */
        this.clearBtn = document.createElement("span");
        this.clearBtn.className = "combobox-clear";
        this.clearBtn.textContent = "\u00d7";
        this.clearBtn.style.display = "none";
        this.el.appendChild(this.clearBtn);
        this.clearBtn.addEventListener("mousedown", e => { e.preventDefault(); this.input.value = ""; this._updateClear(); this._open(); if (this.onChange) this.onChange(""); });
        this.input.addEventListener("focus", () => this._open());
        this.input.addEventListener("input", () => { this._filter(); this._updateClear(); });
        this.input.addEventListener("keydown", (e) => this._onKey(e));
        this.input.addEventListener("blur", () => setTimeout(() => this._close(), 150));
        this._render(this.options);
    }
    setOptions(o) { this.options = o; this._render(o); }
    setValue(v) { this.input.value = v || ""; this._updateClear(); }
    getValue() { return this.input.value.trim(); }
    _open() { this._render(this.options); this.el.classList.add("open"); this.activeIdx = -1; }
    _close() { this.el.classList.remove("open"); }
    _filter() {
        const q = this.input.value.toLowerCase();
        const f = q ? this.options.filter(o => o.toLowerCase().includes(q)) : this.options;
        this._render(f); this.el.classList.add("open");
    }
    _updateClear() { this.clearBtn.style.display = this.input.value ? "" : "none"; }
    _render(items) {
        this.listEl.innerHTML = ""; this.activeIdx = -1;
        if (!items.length) { const d = document.createElement("div"); d.className = "combobox-item no-match"; d.textContent = "No matches"; this.listEl.appendChild(d); return; }
        items.forEach(t => {
            const d = document.createElement("div"); d.className = "combobox-item"; d.textContent = t;
            d.addEventListener("mousedown", e => { e.preventDefault(); this.input.value = t; this._updateClear(); this._close(); if (this.onChange) this.onChange(t); });
            this.listEl.appendChild(d);
        });
    }
    _onKey(e) {
        const items = this.listEl.querySelectorAll(".combobox-item:not(.no-match)");
        if (e.key === "ArrowDown") { e.preventDefault(); this.activeIdx = Math.min(this.activeIdx + 1, items.length - 1); this._hl(items); }
        else if (e.key === "ArrowUp") { e.preventDefault(); this.activeIdx = Math.max(this.activeIdx - 1, 0); this._hl(items); }
        else if (e.key === "Enter") { e.preventDefault(); if (this.activeIdx >= 0 && items[this.activeIdx]) this.input.value = items[this.activeIdx].textContent; this._close(); if (this.onChange) this.onChange(this.input.value); }
        else if (e.key === "Escape") this._close();
    }
    _hl(items) { items.forEach((el, i) => el.classList.toggle("active", i === this.activeIdx)); if (items[this.activeIdx]) items[this.activeIdx].scrollIntoView({ block: "nearest" }); }
}

/* Thread options */
let threadOptions = { types: [], sizes: {}, pitches: {}, classes: [] };
let cbThreadType, cbThreadSize, cbThreadPitch, cbThreadClass;

async function loadThreadOptions() {
    try { const r = await fetch("/thread_options"); threadOptions = await r.json(); }
    catch (e) { clog("Failed to load thread options", "err"); }
    const elType = document.getElementById("cb-thread-type");
    if (elType) cbThreadType = new Combobox(elType, threadOptions.types, onThreadTypeChange);

    const elSize = document.getElementById("cb-thread-size");
    if (elSize) cbThreadSize = new Combobox(elSize, [], onThreadFieldChange);

    const elClass = document.getElementById("cb-thread-class");
    if (elClass) cbThreadClass = new Combobox(elClass, threadOptions.classes, onThreadFieldChange);
}
function onThreadTypeChange(val) {
    cbThreadSize.setOptions(threadOptions.sizes[val] || []); cbThreadSize.setValue("");
    onThreadFieldChange();
}
function onThreadFieldChange() {
    if (selectedMeshes.size === 0) return;

    // Use values from UI components (assumes all selected share these settings or are being overwritten)
    const ty = cbThreadType.getValue(), sz = cbThreadSize.getValue();
    const cl = cbThreadClass.getValue();
    const threadData = (ty && ty !== "None") ? { type: ty, size: sz, class: cl } : null;

    const updates = [];
    selectedMeshes.forEach(m => {
        m.userData.thread = threadData;
        updates.push({ face_id: m.userData.faceId, thread: threadData });
    });

    fetch("/set_thread", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ updates: updates }),
    })
        .then(r => r.json())
        .then(d => { if (d.db_updated_count) clog(`DB updated threads for ${d.db_updated_count} faces`, "ok"); })
        .catch(e => clog("set_thread error: " + e, "err"));

    /* Refresh Hole Wizard UI if open */
    loadHoleManager();
}
loadThreadOptions();

/* Tolerance options */
let tolOptions = { types: [], values: [] };
let cbTolType, cbTolValue;

async function loadToleranceOptions() {
    try { const r = await fetch("/tolerance_options"); tolOptions = await r.json(); }
    catch (e) { clog("Failed to load tolerance options", "err"); }
    const elTolType = document.getElementById("cb-tol-type");
    if (elTolType) cbTolType = new Combobox(elTolType, tolOptions.types, onTolFieldChange);

    const elTolValue = document.getElementById("cb-tol-value");
    if (elTolValue) cbTolValue = new Combobox(elTolValue, tolOptions.values, onTolFieldChange);

    if (inpDatum) inpDatum.addEventListener("change", onTolFieldChange);
}
function onTolFieldChange() {
    if (selectedMeshes.size === 0) return;
    /* Sync to all selected */
    const type = cbTolType.getValue(), val = cbTolValue.getValue(), datum = inpDatum.value;
    const tol = (type && type !== "None") ? { type, value: val, datum } : null;

    const updates = [];
    selectedMeshes.forEach(m => {
        m.userData.tolerance = tol;
        updates.push({ face_id: m.userData.faceId, tolerance: tol });
    });

    fetch("/set_tolerance", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ updates: updates }),
    })
        .then(r => r.json())
        .then(d => {
            if (d.db_updated_count) clog(`DB updated tolerances for ${d.db_updated_count} faces`, "ok");
            /* Refresh heat map UI to show new or updated groups */
            loadHeatMapManager();
        })
        .catch(e => clog("set_tolerance error: " + e, "err"));
}
loadToleranceOptions();

/* ══════════════════════════════════════════════════
   MAIN VIEWPORT
   ══════════════════════════════════════════════════ */
const scene = new THREE.Scene();
scene.background = new THREE.Color(0xffffff);

/* Orthographic camera - no perspective distortion (CAD-style) */
const frustumSize = 100;
const aspect = container.clientWidth / container.clientHeight;
const camera = new THREE.OrthographicCamera(
    -frustumSize * aspect / 2, frustumSize * aspect / 2,
    frustumSize / 2, -frustumSize / 2,
    0.01, 100000
);
camera.position.set(50, 50, 100);

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(window.devicePixelRatio);
renderer.shadowMap.enabled = false;
renderer.outputColorSpace = THREE.SRGBColorSpace;
container.appendChild(renderer.domElement);

const controls = new ArcballControls(camera, renderer.domElement, scene);
controls.enableDamping = true;
controls.dampingFactor = 8;
controls.enableZoom = true; /* Enable built-in zoom */
controls.enablePan = true;
controls.setGizmosVisible(false); /* Hide default Arcball gizmo if preferred, or true to show */

/* Custom zoom handler removed to fix glitchy behavior */

/* ── 3-Point Lighting ────────────────────────────── */
const ambientLight = new THREE.AmbientLight(0xffffff, 0.4);
scene.add(ambientLight);

/* Key light - main light from front-right-above (warm) */
const keyLight = new THREE.DirectionalLight(0xfffaec, 1.8);
keyLight.position.set(100, 150, 100);
scene.add(keyLight);

/* Fill light - softer light from front-left (cool) */
const fillLight = new THREE.DirectionalLight(0xeef4ff, 1.0);
fillLight.position.set(-80, 50, 80);
scene.add(fillLight);

/* Back/rim light - from behind for definition */
const backLight = new THREE.DirectionalLight(0xffffff, 1.0);
backLight.position.set(0, 50, -150);
scene.add(backLight);

/* Hemisphere for ambient fill */
const hemiLight = new THREE.HemisphereLight(0xf0f4f8, 0xd1d5db, 0.4);
scene.add(hemiLight);

/* Lighting presets */
let lightingMode = 0; /* 0=3-point, 1=flat, 2=dramatic */
function setLightingMode(mode) {
    lightingMode = mode;
    if (mode === 0) { /* 3-Point (default) */
        ambientLight.intensity = 0.4;
        keyLight.intensity = 0.9; keyLight.position.set(100, 150, 100);
        fillLight.intensity = 0.4; fillLight.position.set(-80, 50, 80);
        backLight.intensity = 0.3;
        hemiLight.intensity = 0.25;
    } else if (mode === 1) { /* Flat */
        ambientLight.intensity = 0.8;
        keyLight.intensity = 0.3;
        fillLight.intensity = 0.3;
        backLight.intensity = 0.1;
        hemiLight.intensity = 0.4;
    } else { /* Dramatic */
        ambientLight.intensity = 0.2;
        keyLight.intensity = 1.2; keyLight.position.set(150, 200, 50);
        fillLight.intensity = 0.15; fillLight.position.set(-100, 0, 50);
        backLight.intensity = 0.5;
        hemiLight.intensity = 0.1;
    }
    clog(`Lighting: ${['3-Point', 'Flat', 'Dramatic'][mode]}`);
}

/* View Cube removed */

/* ── State ──────────────────────────────────────── */
const DEFAULT_COLOR = new THREE.Color(0x90a4ae); /* Neutral gray for default faces */
const SELECT_EMISSIVE = new THREE.Color(0xec4899);
let faceMeshes = [], faceGroup = null, selectedMeshes = new Set(); /* Multi-select support */
let edgeGroup = null;   /* separate group so we can toggle */
let colorSyncTimer = null, pendingSyncFaceId = null, pendingSyncHex = null, activeSyncPromise = null;
let modelUuid = null;   /* UUID for current model */
let selectionClock = null; /* for pulsing selection */
let isColorPickerActive = false; /* disable selection glow during color pick */

/* Heat map colors & State */
let hmColorTight = "#f44336"; /* Red for tight tolerances */
let hmColorLoose = "#b0b0b0"; /* Gray for loose tolerances */
let isHeatMapActive = false;
let heatMapVisibility = {}; /* { "Linear 0.005": true/false } */
let heatMapColorOverrides = {}; /* { "Linear 0.005": "#ff0000" } */
let modelCentroid = new THREE.Vector3();

/* ══════════════════════════════════════════════════
   HEAT MAP LOGIC
   ══════════════════════════════════════════════════ */
function applyHeatMap() {
    if (!isHeatMapActive) return;

    faceMeshes.forEach(mesh => {
        /* Save original color before heat map overwrites it */
        if (!mesh.userData.savedColor) {
            mesh.userData.savedColor = mesh.material.color.clone();
        }

        const tol = mesh.userData.tolerance;
        if (tol && tol.type && tol.type !== 'None') {
            const key = `${tol.type} ${tol.value || ''}`;

            if (heatMapVisibility[key] === false) {
                mesh.material.color.setHex(0xf0f0f0); /* Ghosted */
                mesh.material.transparent = true;
                mesh.material.opacity = 0.3;
            } else {
                mesh.material.transparent = false;
                mesh.material.opacity = 1.0;

                /* Determine color based on value (Tight vs Loose) */
                /* Simple heuristic: if value < 0.005 it's tight, else loose/medium */
                /* TODO: Use the sliders for this logic */
                let isTight = false;
                if (tol.value) {
                    const v = parseFloat(tol.value);
                    if (!isNaN(v) && v <= 0.005) isTight = true;
                }
                const defColor = isTight ? hmColorTight : hmColorLoose;
                mesh.material.color.set(heatMapColorOverrides[key] || defColor);
            }
        } else {
            /* No tolerance data -> Light Gray or ghosted? */
            mesh.material.color.setHex(0xe0e0e0);
            mesh.material.transparent = true;
            mesh.material.opacity = 0.2;
        }
    });
    clog("Heat Map: Updated");
}

function removeHeatMap() {
    isHeatMapActive = false;
    faceMeshes.forEach(mesh => {
        mesh.material.transparent = false;
        mesh.material.opacity = 1.0;
        if (mesh.userData.savedColor) {
            mesh.material.color.copy(mesh.userData.savedColor);
        } else {
            mesh.material.color.copy(DEFAULT_COLOR);
        }
    });
    clog("Heat Map: Deactivated");
}

function loadHeatMapManager() {
    const hmGroups = document.getElementById('heatmap-groups');
    if (!hmGroups) return;

    const tolMap = {};
    faceMeshes.forEach(mesh => {
        const tol = mesh.userData.tolerance;
        if (tol && tol.type && tol.type !== 'None') {
            const key = `${tol.type} ${tol.value || ''}`;
            if (!tolMap[key]) tolMap[key] = [];
            tolMap[key].push(mesh);
        }
    });

    const keys = Object.keys(tolMap).sort();
    if (keys.length === 0) {
        hmGroups.innerHTML = '<div style="color:#6b7280; font-size:11px; font-style:italic;">No tolerance data found.</div>';
    } else {
        hmGroups.innerHTML = '';
        keys.forEach(key => {
            const faces = tolMap[key];
            const isVisible = heatMapVisibility[key] !== false;

            /* Calculate default color for this group */
            let defColor = hmColorLoose;

            /* Check if first face has a custom color (not default grey) */
            const firstFace = faces[0];
            let hasCustomColor = false;
            if (firstFace && firstFace.userData.originalColor) {
                const hex = "#" + firstFace.userData.originalColor.getHexString();
                if (hex !== "#90a4ae") {
                    defColor = hex;
                    hasCustomColor = true;
                }
            }

            if (!hasCustomColor) {
                /* Heuristic: check first face's value */
                let isTight = false;
                const firstTol = firstFace?.userData?.tolerance;
                if (firstTol && firstTol.value) {
                    const v = parseFloat(firstTol.value);
                    if (!isNaN(v) && v <= 0.005) isTight = true;
                }
                defColor = isTight ? hmColorTight : hmColorLoose;
            }

            const activeColor = heatMapColorOverrides[key] || defColor;

            /* Store the computed color so applyHeatMap uses it */
            if (!heatMapColorOverrides[key]) {
                heatMapColorOverrides[key] = activeColor;
            }

            const group = document.createElement('div');
            group.className = 'thread-group'; /* Reuse styling */
            if (!isVisible) group.style.opacity = '0.6';

            group.innerHTML = `
                <div class="thread-group-header">
                    <div style="display:flex; align-items:center; gap:8px;">
                        <div class="group-icon group-vis-toggle" title="Toggle Visibility" style="cursor:pointer; opacity:0.9; color:#64748b;">
                             ${isVisible ?
                    '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>' :
                    '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M1 1l22 22"/><path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19M14.12 14.12a3 3 0 1 1-4.24-4.24"/></svg>'
                }
                        </div>
                        <input type="color" class="group-color-picker" value="${activeColor}" style="width:24px; height:24px; border:none; padding:0; background:none; cursor:pointer;">
                        <span class="thread-group-title" style="${!isVisible ? 'text-decoration:line-through; color:#888;' : ''}">${key}</span>
                    </div>
                    
                    <div style="display:flex; align-items:center; gap:8px;">
                        <span class="thread-group-count">${faces.length}</span>
                        <div class="group-icon group-delete" title="Delete Group" style="cursor:pointer; opacity:0.7; color:#ef4444; margin-left:4px;">
                            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 6L6 18M6 6l12 12"/></svg>
                        </div>
                    </div>
                </div>
                <div class="thread-group-content" style="${!isVisible ? 'display:none;' : ''}">
                    ${faces.map((m, i) => `<div class="thread-item">Face ${i + 1}: ${String(m.userData.faceId).slice(0, 8)}</div>`).join('')}
                </div>
            `;

            /* Header click to expand (excluding icons) */
            const header = group.querySelector('.thread-group-header');
            header.addEventListener('click', (e) => {
                if (e.target.closest('.group-icon') || e.target.tagName === 'INPUT') return;
                group.classList.toggle('expanded');
            });

            /* Visibility Toggle */
            const visBtn = group.querySelector('.group-vis-toggle');
            visBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                heatMapVisibility[key] = !isVisible;
                loadHeatMapManager();
                if (isHeatMapActive) applyHeatMap();
            });

            /* Delete Group */
            const delBtn = group.querySelector('.group-delete');
            delBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                if (!confirm(`Delete tolerance group "${key}"? This will remove tolerances from ${faces.length} faces.`)) return;

                const updates = faces.map(f => ({
                    face_id: f.userData.faceId,
                    tolerance: null
                }));

                fetch('/set_tolerance', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ updates })
                })
                    .then(r => r.json())
                    .then(data => {
                        if (data.ok) {
                            /* Update local state */
                            faces.forEach(f => {
                                if (f.userData.tolerance) delete f.userData.tolerance;
                            });
                            clog(`Deleted tolerance group: ${key}`, "ok");
                            /* Refresh UI */
                            loadHeatMapManager();
                            if (isHeatMapActive) applyHeatMap();
                        } else {
                            clog("Failed to delete tolerance group", "err");
                            alert("Failed to delete tolerance group");
                        }
                    })
                    .catch(e => {
                        clog("Error deleting group: " + e, "err");
                    });
            });

            /* Color Picker */
            const picker = group.querySelector('.group-color-picker');
            picker.addEventListener('input', (e) => {
                e.stopPropagation();
                heatMapColorOverrides[key] = e.target.value;
                if (isHeatMapActive) applyHeatMap();

                /* Sync to backend */
                const updates = faces.map(f => ({ face_id: f.userData.faceId, color: e.target.value }));
                syncBatchColor(updates);
            });
            picker.addEventListener('click', (e) => e.stopPropagation());

            hmGroups.appendChild(group);
        });
    }

    /* Ensure the viewport colors match the current group settings */
    if (isHeatMapActive) applyHeatMap();
}

/* ── Resize ─────────────────────────────────────── */
function resize() {
    const w = container.clientWidth, h = container.clientHeight;
    const aspect = w / h;
    /* For orthographic camera, update frustum bounds */
    const frustum = camera.top - camera.bottom; /* current frustum height */
    camera.left = -frustum * aspect / 2;
    camera.right = frustum * aspect / 2;
    camera.updateProjectionMatrix();
    renderer.setSize(w, h);
}
window.addEventListener("resize", resize); resize();

/* ── Render loop ────────────────────────────────── */
(function animate() {
    requestAnimationFrame(animate);
    controls.update();

    /* Pulsing selection glow (disabled during color picking) */
    /* Pulsing selection glow (disabled during color picking) */
    if (selectedMeshes.size > 0 && !isColorPickerActive) {
        const t = performance.now() * 0.004; /* Faster pulse */
        const intensity = 0.25 + 0.1 * Math.sin(t); /* Less severe pulse */
        selectedMeshes.forEach(m => m.material.emissiveIntensity = intensity);
    }

    renderer.render(scene, camera);
})();

/* ══════════════════════════════════════════════════
   TOOLBAR TOGGLE HANDLERS
   ══════════════════════════════════════════════════ */
function toggle(btn, obj) {
    btn.classList.toggle("active");
    const on = btn.classList.contains("active");
    if (obj) obj.visible = on;
    return on;
}

/* Grid & Snap listeners removed */
if (tbEdges) {
    tbEdges.addEventListener("click", () => {
        const on = toggle(tbEdges, edgeGroup);
        clog(`Edges ${on ? "ON" : "OFF"}`);
    });
}
if (tbFit) {
    tbFit.addEventListener("click", () => {
        if (faceGroup) { fitCameraToGroup(faceGroup); clog("Camera fit to model"); }
    });
}
/* Lighting Modal Logic */
const lightingModal = document.getElementById("lighting-modal");
const closeLightingBtn = document.getElementById("close-lighting");
const tbLight = document.getElementById("tb-light");
const lightPreset = document.getElementById("light-preset");
const lightAmbient = document.getElementById("light-ambient");
const lightKey = document.getElementById("light-key");
const lightFill = document.getElementById("light-fill");
const lightBack = document.getElementById("light-back");

if (tbLight) {
    tbLight.addEventListener("click", () => {
        lightingModal.classList.toggle("hidden");
        tbLight.classList.toggle("active", !lightingModal.classList.contains("hidden"));
    });
}

if (closeLightingBtn) {
    closeLightingBtn.addEventListener("click", () => {
        lightingModal.classList.add("hidden");
        tbLight.classList.remove("active");
    });
}

/* Update lights from sliders */
function updateLights() {
    ambientLight.intensity = parseFloat(lightAmbient.value);
    keyLight.intensity = parseFloat(lightKey.value);
    fillLight.intensity = parseFloat(lightFill.value);
    backLight.intensity = parseFloat(lightBack.value);
}

[lightAmbient, lightKey, lightFill, lightBack].forEach(el => {
    if (el) el.addEventListener("input", updateLights);
});

/* Presets */
if (lightPreset) {
    lightPreset.addEventListener("change", () => {
        const mode = parseInt(lightPreset.value);
        setLightingMode(mode);
    });
}
/* Override setLightingMode to update sliders too */
const _originalSetLightingMode = setLightingMode;
setLightingMode = function (mode) {
    /* Call original to set lights */
    _originalSetLightingMode(mode);

    /* Update UI sliders to match */
    lightAmbient.value = ambientLight.intensity;
    lightKey.value = keyLight.intensity;
    fillLight.value = fillLight.intensity;
    backLight.value = backLight.intensity;
    lightPreset.value = mode;
};

/* ══════════════════════════════════════════════════
   DROP ZONE & FILE IMPORT
   ══════════════════════════════════════════════════ */
['dragenter', 'dragover', 'dragleave', 'drop'].forEach(evt => {
    dropZone.addEventListener(evt, e => { e.preventDefault(); e.stopPropagation(); });
});
['dragenter', 'dragover'].forEach(evt => {
    dropZone.addEventListener(evt, () => dropZone.classList.add('drag-over'));
});
['dragleave', 'drop'].forEach(evt => {
    dropZone.addEventListener(evt, () => dropZone.classList.remove('drag-over'));
});
dropZone.addEventListener('drop', e => {
    const files = e.dataTransfer.files;
    if (files.length) {
        fileInput.files = files;
        fileInput.dispatchEvent(new Event('change'));
    }
});
dropZone.addEventListener('click', () => fileInput.click());

fileInput.addEventListener("change", async () => {
    if (!fileInput.files.length) return;
    const name = fileInput.files[0].name;
    uploadLabel.innerHTML = name;
    dropZone.classList.add('has-file');
    clog(`Uploading ${name}...`);

    const formData = new FormData();
    formData.append("file", fileInput.files[0]);

    loading.classList.remove("hidden");
    exportSection.classList.add("hidden");
    deselectAll();

    try {
        const resp = await fetch("/upload", { method: "POST", body: formData });
        const data = await resp.json();
        if (!resp.ok) { clog(data.error || "Upload failed", "err"); alert(data.error); return; }
        modelUuid = data.uuid || null;
        if (modelUuid) {
            modelUuidEl.textContent = modelUuid;
            /* Update URL without reload */
            history.pushState(null, '', '/' + modelUuid);
            clog(`Model persistent at /${modelUuid}`);
        }
        clog(`Loaded ${data.faces.length} faces from ${name}`, "ok");
        buildScene(data.faces);
    } catch (err) {
        clog("Upload error: " + err.message, "err");
    } finally {
        loading.classList.add("hidden");
    }
});

/* ══════════════════════════════════════════════════
   BUILD SCENE
   ══════════════════════════════════════════════════ */
function buildScene(faces) {
    if (faceGroup) { scene.remove(faceGroup); faceGroup.traverse(c => { if (c.geometry) c.geometry.dispose(); if (c.material) c.material.dispose(); }); }
    if (edgeGroup) { scene.remove(edgeGroup); edgeGroup.traverse(c => { if (c.geometry) c.geometry.dispose(); if (c.material) c.material.dispose(); }); }
    faceMeshes = []; selectedMeshes.clear();
    faceGroup = new THREE.Group();
    edgeGroup = new THREE.Group();

    faces.forEach(fd => {
        const geo = new THREE.BufferGeometry();
        geo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(fd.vertices), 3));
        if (fd.normals?.length) geo.setAttribute("normal", new THREE.BufferAttribute(new Float32Array(fd.normals), 3));
        if (fd.indices?.length) geo.setIndex(fd.indices);
        if (!fd.normals?.length) geo.computeVertexNormals();

        const faceColor = fd.color ? new THREE.Color(fd.color) : DEFAULT_COLOR.clone();
        const mat = new THREE.MeshPhongMaterial({ color: faceColor, side: THREE.DoubleSide, shininess: 40, specular: new THREE.Color(0x222222) });
        const mesh = new THREE.Mesh(geo, mat);
        mesh.userData = {
            faceId: fd.id,
            originalColor: faceColor.clone(),
            vertCount: fd.vertices.length / 3,
            triCount: fd.indices.length / 3,
            thread: fd.thread || null,
            tolerance: fd.tolerance || null
        };
        faceGroup.add(mesh);
        faceMeshes.push(mesh);
    });

    faceMeshes.forEach(src => {
        const edges = new THREE.EdgesGeometry(src.geometry, 15);
        /* Thicker edges: increased opacity + linewidth (visual weight) */
        edgeGroup.add(new THREE.LineSegments(edges, new THREE.LineBasicMaterial({ color: 0x37474f, opacity: 0.25, transparent: true, linewidth: 2 })));
    });

    scene.add(faceGroup);
    scene.add(edgeGroup);
    /* Respect current toolbar state */
    edgeGroup.visible = tbEdges.classList.contains("active");

    fitCameraToGroup(faceGroup);
    exportSection.classList.remove("hidden");

    /* Populate Hole Wizard with new model data */
    loadHoleManager();
}

/* ── Camera framing ─────────────────────────────── */
function fitCameraToGroup(group) {
    const box = new THREE.Box3().setFromObject(group);
    const center = box.getCenter(new THREE.Vector3());
    const size = box.getSize(new THREE.Vector3());
    const maxDim = Math.max(size.x, size.y, size.z);

    /* Store model centroid for SolidWorks-style orbiting */
    modelCentroid.copy(center);
    controls.target.copy(center);

    /* Set orthographic frustum to fit model with padding */
    const padding = 1.5;
    const aspect = container.clientWidth / container.clientHeight;
    const frustumHeight = maxDim * padding;
    camera.top = frustumHeight / 2;
    camera.bottom = -frustumHeight / 2;
    camera.left = -frustumHeight * aspect / 2;
    camera.right = frustumHeight * aspect / 2;

    /* Position camera at isometric angle (front-left-bottom view) */
    const isoOffset = new THREE.Vector3(-1, -1, 1).normalize().multiplyScalar(maxDim * 2);
    camera.position.copy(center.clone().add(isoOffset));
    camera.up.set(0, 0, 1); /* Z-up for this view angle */
    camera.near = 0.01;
    camera.far = maxDim * 100;
    camera.updateProjectionMatrix();
    camera.lookAt(center);
    controls.update();
}

/* ══════════════════════════════════════════════════
   FACE PICKING
   ══════════════════════════════════════════════════ */
const raycaster = new THREE.Raycaster();
const mouse = new THREE.Vector2();
let ptrDown = { x: 0, y: 0 };

renderer.domElement.addEventListener("pointerdown", e => {
    ptrDown = { x: e.clientX, y: e.clientY };
    renderer.domElement.addEventListener("pointerup", onPointerUp, { once: true });
});

function onPointerUp(e) {
    if (Math.hypot(e.clientX - ptrDown.x, e.clientY - ptrDown.y) > 5) return;
    const r = renderer.domElement.getBoundingClientRect();
    mouse.x = ((e.clientX - r.left) / r.width) * 2 - 1;
    mouse.y = -((e.clientY - r.top) / r.height) * 2 + 1;
    raycaster.setFromCamera(mouse, camera);
    const hits = raycaster.intersectObjects(faceMeshes);

    /* Handle Multi-select with Shift/Ctrl */
    const isMulti = e.shiftKey || e.ctrlKey || e.metaKey;
    hits.length ? selectFace(hits[0].object, isMulti) : deselectAll();
}

function selectFace(mesh, isMulti = false) {
    if (!isMulti) {
        /* If single select, clear others unless clicking already selected one (toggle behavior optional, standard CAD usually clears) */
        if (!selectedMeshes.has(mesh) || selectedMeshes.size > 1) deselectAll();
    }

    if (selectedMeshes.has(mesh)) {
        /* Deselect if already selected (toggle) */
        mesh.material.emissive.set(0x000000);
        mesh.material.emissiveIntensity = 0;
        selectedMeshes.delete(mesh);
        if (selectedMeshes.size === 0) rightPanel.classList.add("hidden");
    } else {
        /* Select new face */
        selectedMeshes.add(mesh);
        mesh.material.emissive.copy(SELECT_EMISSIVE);
        mesh.material.emissiveIntensity = 0.25;

        /* Switch to Properties View automatically */
        if (activeView !== 'props' || rightPanel.classList.contains("hidden")) {
            switchRightPanelView('props');
        } else {
            /* Already open & props, ensure UI is visible (redundant but safe) */
            rightPanel.classList.remove("hidden");
        }

        /* Update UI with last selected face info */
        rpFaceId.textContent = selectedMeshes.size > 1 ? `${selectedMeshes.size} faces` : `#${mesh.userData.faceId}`;
        rpFaceType.textContent = "Planar";
        rpFaceArea.textContent = `${mesh.userData.triCount} tris`;
        colorPicker.value = "#" + mesh.material.color.getHexString();

        const th = mesh.userData.thread;
        /* Only show thread info if single select or (future) common props */
        if (selectedMeshes.size === 1) {
            if (cbThreadType) cbThreadType.setValue(th?.type || "");
            if (cbThreadSize) { cbThreadSize.setOptions(threadOptions.sizes[th?.type] || []); cbThreadSize.setValue(th?.size || ""); }
            if (cbThreadPitch) { cbThreadPitch.setOptions(threadOptions.pitches[th?.type] || []); cbThreadPitch.setValue(th?.pitch || ""); }
            if (cbThreadClass) cbThreadClass.setValue(th?.class || "");

            const tol = mesh.userData.tolerance;
            if (cbTolType) cbTolType.setValue(tol?.type || "");
            if (cbTolValue) cbTolValue.setValue(tol?.value || "");
            if (inpDatum) inpDatum.value = tol?.datum || "";
        }

        rightPanel.classList.remove("hidden");
        clog(`Selected Face #${mesh.userData.faceId}`);
    }
}

function deselectAll() {
    selectedMeshes.forEach(m => {
        m.material.emissive.set(0x000000);
        m.material.emissiveIntensity = 0;
    });
    selectedMeshes.clear();
    rightPanel.classList.add("hidden");
}

/* Global Escape to deselect */
window.addEventListener("keydown", e => {
    if (e.key === "Escape") deselectAll();
});

rpClose.addEventListener("click", deselectAll);

/* ══════════════════════════════════════════════════
   COLOR SYNC
   ══════════════════════════════════════════════════ */
/* Disable selection glow while color picker is active */
colorPicker.addEventListener("focus", () => {
    isColorPickerActive = true;
    selectedMeshes.forEach(m => {
        m.material.emissive.set(0x000000);
        m.material.emissiveIntensity = 0;
    });
});

colorPicker.addEventListener("blur", () => {
    isColorPickerActive = false;
    selectedMeshes.forEach(m => m.material.emissive.copy(SELECT_EMISSIVE));
});

colorPicker.addEventListener("input", e => {
    if (selectedMeshes.size === 0) return;
    const c = new THREE.Color(e.target.value);

    selectedMeshes.forEach(m => {
        m.material.color.copy(c);
        m.userData.originalColor = c.clone();
    });

    /* Batch sync color for all selected faces */
    if (selectedMeshes.size > 0) {
        /* Prepare batch update payload */
        pendingBatchUpdates = [];
        selectedMeshes.forEach(m => {
            pendingBatchUpdates.push({ face_id: m.userData.faceId, color: e.target.value });
        });

        clearTimeout(colorSyncTimer);
        colorSyncTimer = setTimeout(() => syncBatchColor(pendingBatchUpdates), 150);
    }
});

/* Batch update state */
let pendingBatchUpdates = [];

async function syncBatchColor(updates) {
    if (!updates || updates.length === 0) return;
    try {
        const r = await fetch("/set_color", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ updates: updates })
        });
        const d = await r.json();
        if (!r.ok) { clog("set_color: " + d.error, "err"); }
        else if (d.db_updated_count > 0) { clog(`DB updated colors for ${d.db_updated_count} faces`, "ok"); }
    } catch (e) { clog("syncBatchColor error: " + e, "err"); }
}

/* Compat wrapper for other callers (like reset button) */
async function syncColor(faceId, hex) {
    return syncBatchColor([{ face_id: faceId, color: hex }]);
}

async function flushColorSync() {
    if (colorSyncTimer) {
        clearTimeout(colorSyncTimer);
        colorSyncTimer = null;
        if (pendingBatchUpdates.length > 0) {
            await syncBatchColor(pendingBatchUpdates);
            pendingBatchUpdates = [];
        }
    }
    if (activeSyncPromise) await activeSyncPromise;
}

resetColorBtn.addEventListener("click", () => {
    if (selectedMeshes.size === 0) return;
    clearTimeout(colorSyncTimer); pendingSyncFaceId = null; pendingSyncHex = null;

    const defHex = "#" + DEFAULT_COLOR.getHexString();
    colorPicker.value = defHex;

    const updates = [];
    selectedMeshes.forEach(m => {
        m.material.color.copy(DEFAULT_COLOR);
        m.userData.originalColor = DEFAULT_COLOR.clone();
        updates.push({ face_id: m.userData.faceId, color: defHex });
    });

    syncBatchColor(updates);
    clog(`Reset color on ${selectedMeshes.size} faces`);
});

/* ══════════════════════════════════════════════════
   EXPORT
   ══════════════════════════════════════════════════ */
exportBtn.addEventListener("click", async () => {
    exportBtn.disabled = true;
    exportBtn.textContent = "Syncing...";
    clog("Exporting STEP...");
    await flushColorSync();
    exportBtn.textContent = "Writing...";
    try {
        const resp = await fetch("/export");
        if (!resp.ok) { const d = await resp.json(); clog("Export failed: " + d.error, "err"); alert(d.error); return; }
        const blob = await resp.blob();
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = resp.headers.get("Content-Disposition")?.match(/filename="?(.+?)"?$/)?.[1] || "export.step";
        document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(url);
        clog(`Exported ${(blob.size / 1024).toFixed(1)} KB`, "ok");
    } catch (e) { clog("Export error: " + e, "err"); }
    finally { exportBtn.disabled = false; exportBtn.textContent = "Export Colored STEP"; }
});

/* ══════════════════════════════════════════════════
   HOLE MANAGER & EXPANSION
   ══════════════════════════════════════════════════ */
const rpExpandBtn = document.getElementById("rp-expand-btn");
const holeManagerSection = document.getElementById("hole-manager-section");
const holeList = document.getElementById("hole-list");

if (rpExpandBtn) {
    rpExpandBtn.addEventListener("click", () => {
        rightPanel.classList.toggle("expanded");
        const expanded = rightPanel.classList.contains("expanded");
        rpExpandBtn.innerHTML = expanded ?
            '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 5l7 7-7 7" /></svg>' :
            '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M15 19l-7-7 7-7" /></svg>';

        if (expanded) {
            holeManagerSection.classList.remove("hidden");
            loadHoleManager();
        } else {
            holeManagerSection.classList.add("hidden");
        }
    });
}

/* ══════════════════════════════════════════════════
   TOLERANCE HEAT MAP
   ══════════════════════════════════════════════════ */
/* Panel Sections */
const heatmapSection = document.getElementById("heatmap-section");
const hmThreshold = document.getElementById("hm-threshold");
const hmVal = document.getElementById("hm-val");
const rpDefaultView = document.getElementById("rp-default-view");
// holeManagerSection is already declared above, no need to redeclare.

/* isHeatMapActive declared at top of file (or near ApplyHeatMap). 
   We remove this duplicate declaration if it exists, or rename it. 
   Actually, line 273 defines `let isHeatMapActive = false;`.
   Line 881 defines `let isHeatmapActive = false;`.
   We should remove line 881. */
/* let isHeatmapActive = false; // Removed */

/* Legacy Heat Map slider code removed */

/* Tolerance type checkboxes */
const hmShowLinear = document.getElementById("hm-show-linear");
const hmShowLimit = document.getElementById("hm-show-limit");
const hmShowGdt = document.getElementById("hm-show-gdt");
const hmShowFits = document.getElementById("hm-show-fits");

/* Checkbox handlers */
[hmShowLinear, hmShowLimit, hmShowGdt, hmShowFits].forEach(cb => {
    if (cb) cb.addEventListener("change", () => { if (isHeatMapActive) applyHeatMap(); });
});

/* ══════════════════════════════════════════════════
   EVENT BLOCKING (UI vs CANVAS)
   ══════════════════════════════════════════════════ */
/* Stop orbit/zoom when interacting with panels */
/* Note: 'sidebar' and 'rpPanel' are defined later in file, so we check them inside a DOMContentLoaded or verify scope. 
   Actually, they are defined at global scope near bottom. We should probably move this block to bottom or use DOMContentLoaded. 
   For now, we will add listeners to them assuming they exist or defer. 
   Refactor: Put this in init or ensure variables are hoisted/available. 
   Safe bet: Add a setup function or use document.getElementById directly here. */
const _sidebar = document.getElementById("sidebar");
const _rp = document.getElementById("right-panel");

[_sidebar, _rp].forEach(panel => {
    if (!panel) return;
    ['wheel', 'mousedown', 'mouseup', 'pointerdown', 'pointerup', 'touchstart', 'touchend', 'touchmove'].forEach(evt => {
        panel.addEventListener(evt, e => {
            e.stopPropagation();
        });
    });
});

/* Legacy Heat Map code removed */

/* ══════════════════════════════════════════════════
   VIEW CONTROLS - Reliable button-based view switching
   ══════════════════════════════════════════════════ */
function setView(viewName) {
    const dist = camera.position.distanceTo(controls.target);
    const t = controls.target.clone();
    let direction, up;

    switch (viewName) {
        case 'front':
            direction = new THREE.Vector3(0, 0, 1);
            up = new THREE.Vector3(0, 1, 0);
            break;
        case 'back':
            direction = new THREE.Vector3(0, 0, -1);
            up = new THREE.Vector3(0, 1, 0);
            break;
        case 'top':
            direction = new THREE.Vector3(0, 1, 0);
            up = new THREE.Vector3(0, 0, -1);
            break;
        case 'bottom':
            direction = new THREE.Vector3(0, -1, 0);
            up = new THREE.Vector3(0, 0, 1);
            break;
        case 'left':
            direction = new THREE.Vector3(-1, 0, 0);
            up = new THREE.Vector3(0, 1, 0);
            break;
        case 'right':
            direction = new THREE.Vector3(1, 0, 0);
            up = new THREE.Vector3(0, 1, 0);
            break;
        case 'iso':
        default:
            /* Front-left-bottom isometric */
            direction = new THREE.Vector3(-1, -1, 1).normalize();
            up = new THREE.Vector3(0, 0, 1);
            break;
    }

    const offset = direction.multiplyScalar(dist);
    camera.position.copy(t).add(offset);
    camera.up.copy(up);
    camera.lookAt(t);
    camera.updateProjectionMatrix();
    controls.update();
    clog(`View: ${viewName}`);
}

/* View button click handlers */
document.querySelectorAll('.view-btn').forEach(btn => {
    btn.addEventListener('click', () => {
        const view = btn.dataset.view;
        if (view) setView(view);
    });
});

/* ══════════════════════════════════════════════════
   HOLE WIZARD
/* ── Tabbed View Logic ───────────────────────────── */
const rpTabs = document.querySelectorAll(".rp-tab");
const rpTitle = document.getElementById("rp-title");

let activeView = 'props';

function switchRightPanelView(viewName) {
    if (activeView === viewName && !rightPanel.classList.contains("hidden")) {
        // Already active and open -> toggle close
        rightPanel.classList.add("hidden");
        rpTabs.forEach(t => t.classList.remove("active"));

        // Cleanup modes
        if (viewName === 'heatmap') { isHeatMapActive = false; removeHeatMap(); }
        if (viewName === 'holes') { removeHoleMode(); }
        return;
    }

    // Activate
    activeView = viewName;
    rightPanel.classList.remove("hidden");

    // Update Tabs
    rpTabs.forEach(t => {
        if (t.dataset.view === viewName) t.classList.add("active");
        else t.classList.remove("active");
    });

    // Hide all sections first
    if (rpDefaultView) rpDefaultView.classList.add("hidden");
    if (holeManagerSection) holeManagerSection.classList.add("hidden");
    if (heatmapSection) heatmapSection.classList.add("hidden");

    // Show specific section & logic
    if (viewName === 'props') {
        if (rpTitle) rpTitle.textContent = "PROPERTIES";
        if (rpDefaultView) rpDefaultView.classList.remove("hidden");

        // Disable heatmap if switching away
        if (isHeatMapActive) { isHeatMapActive = false; removeHeatMap(); }

        // Disable Hole Mode
        removeHoleMode();
    }
    else if (viewName === 'holes') {
        if (rpTitle) rpTitle.textContent = "HOLE WIZARD";
        if (holeManagerSection) holeManagerSection.classList.remove("hidden");
        loadHoleManager();

        if (isHeatMapActive) { isHeatMapActive = false; removeHeatMap(); }

        /* Enable Hole Coloring Mode */
        applyHoleMode();
    }
    else if (viewName === 'heatmap') {
        if (rpTitle) rpTitle.textContent = "TOLERANCES";
        if (heatmapSection) heatmapSection.classList.remove("hidden");

        /* Disable Hole Mode if active */
        removeHoleMode();

        // Auto-enable heatmap
        isHeatMapActive = true;
        loadHeatMapManager();
        applyHeatMap();
    }
}

// Bind Tab Clicks
rpTabs.forEach(tab => {
    tab.addEventListener("click", (e) => {
        e.stopPropagation(); // Prevent propagation to canvas
        switchRightPanelView(tab.dataset.view);
    });
});

/* ── Hole Coloring Logic ─────────────────────────── */
let isHoleModeActive = false;
const groupColorOverrides = {}; /* Stores user-selected colors for keys */
const groupVisibility = {}; /* Stores visibility state: true (visible) or false (hidden) */

const holePalette = [
    "#F44336", "#E91E63", "#9C27B0", "#673AB7", "#3F51B5",
    "#2196F3", "#03A9F4", "#00BCD4", "#009688", "#4CAF50",
    "#8BC34A", "#CDDC39", "#FFEB3B", "#FFC107", "#FF9800",
    "#FF5722", "#795548", "#9E9E9E", "#607D8B"
];

function applyHoleMode() {
    isHoleModeActive = true;

    /* 1. Identify Groups */
    const threadMap = {};
    faceMeshes.forEach(mesh => {
        const thread = mesh.userData.thread;
        if (thread && thread.type && thread.type !== 'None') {
            const key = `${thread.type} ${thread.size || ''}`;
            if (!threadMap[key]) threadMap[key] = [];
            threadMap[key].push(mesh);
        }
    });

    /* Assign color index to keys */
    const keys = Object.keys(threadMap).sort();
    const colorMap = {};
    keys.forEach((k, i) => {
        /* Determine default color from first face */
        let defColor = holePalette[i % holePalette.length];
        const faces = threadMap[k];
        if (faces && faces.length > 0) {
            const f = faces[0];
            if (f.userData.originalColor && f.userData.originalColor.getHexString() !== "90a4ae") {
                defColor = "#" + f.userData.originalColor.getHexString();
            }
        }

        /* Use override if available, else default */
        colorMap[k] = groupColorOverrides[k] || defColor;
    });

    /* 2. Apply Colors */
    faceMeshes.forEach(mesh => {
        // Save original color if not saved
        if (!mesh.userData.savedColor) {
            mesh.userData.savedColor = mesh.material.color.clone();
        }

        const thread = mesh.userData.thread;
        const isCyl = mesh.userData.surfaceType === 'Cylinder';

        if (thread && thread.type && thread.type !== 'None') {
            // Threaded Hole -> Group Color
            const key = `${thread.type} ${thread.size || ''}`;
            if (groupVisibility[key] !== false) {
                mesh.material.color.set(colorMap[key]);
            } else {
                mesh.material.color.setHex(0xf0f0f0);
            }
        }
        else if (isCyl) {
            // Plain Cylinder -> Generic Hole Color (e.g., Light Blue or just dark grey to stand out less than thread?)
            // For now, let's make them distinct or just keep them ghosted if they aren't "threaded"?
            // User said "color to each group". If it's just a hole without thread, maybe treat as "Unthreaded"?
            // Let's use a specific color for unthreaded cylinders to aid ID.
            mesh.material.color.setHex(0x00bcd4); // Cyan for unthreaded cylinders
        }
        else {
            // Non-hole -> Ghost (Slight Gray)
            mesh.material.color.setHex(0xf0f0f0);
        }
    });
    clog("Hole Mode: Active");
}

function removeHoleMode() {
    if (!isHoleModeActive) return;
    isHoleModeActive = false;

    faceMeshes.forEach(mesh => {
        if (mesh.userData.savedColor) {
            mesh.material.color.copy(mesh.userData.savedColor);
            // mesh.userData.savedColor = null; // Don't clear, Heatmap uses it too. 
            // Actually heatmap logic checks if !savedColor then saves. 
            // If we keep it, we might persist stale colors if we aren't careful.
            // But standard behavior is: savedColor = original DB color.
        } else {
            mesh.material.color.set(DEFAULT_COLOR);
        }
    });
    clog("Hole Mode: Deactivated");
}

async function deleteThreadGroup(threadKey, faces) {
    if (!confirm(`Remove thread "${threadKey}" from ${faces.length} faces?`)) return;

    /* Prepare updates to set thread to None */
    const updates = faces.map(m => ({
        face_id: m.userData.faceId,
        thread: { type: "None", size: "None" } // backend might expect dict
    }));

    try {
        /* Send update to backend */
        const r = await fetch("/set_thread", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ updates: updates }),
        });
        const d = await r.json();
        if (d.db_updated_count) clog(`Removed thread from ${d.db_updated_count} faces`, "ok");

        /* Update local userData and UI */
        faces.forEach(m => {
            m.userData.thread = { type: 'None', size: 'None' };
        });

        loadHoleManager(); // Refresh UI
        // applyHoleMode(); // Auto-refreshed by loadHoleManager if active
    } catch (e) {
        clog("Failed to delete group: " + e, "err");
    }
}

/* Load hole manager data from face metadata (user-defined thread data) */
function loadHoleManager() {
    const threadGroups = document.getElementById('thread-groups');
    const holeList = document.getElementById('hole-list');

    if (!threadGroups || !holeList) return;

    /* Collect faces with thread metadata */
    const threadMap = {};  /* { "UNC 1/4-20": [mesh1, mesh2, ...] } */
    const holeData = [];   /* Cylindrical faces with diameters */

    faceMeshes.forEach(mesh => {
        const thread = mesh.userData.thread;
        if (thread && thread.type && thread.type !== 'None') {
            const key = `${thread.type} ${thread.size || ''}`;
            if (!threadMap[key]) threadMap[key] = [];
            threadMap[key].push(mesh);
        }

        /* Also collect cylindrical faces by surface type */
        if (mesh.userData.surfaceType === 'Cylinder') {
            holeData.push(mesh);
        }
    });

    /* Render thread groups */
    const threadKeys = Object.keys(threadMap);
    if (threadKeys.length === 0) {
        threadGroups.innerHTML = '<div style="color:#6b7280; font-size:11px; font-style:italic;">No threaded holes defined. Select a cylindrical face and assign thread data.</div>';
    } else {
        threadGroups.innerHTML = '';
        threadKeys.forEach(key => {
            const faces = threadMap[key];

            /* Determine default color from first face in group */
            const firstFace = faces[0];
            let defaultColor = holePalette[threadKeys.indexOf(key) % holePalette.length];

            /* If face has a custom color (not default #90a4ae), use it */
            if (firstFace && firstFace.userData.originalColor) {
                const fc = firstFace.userData.originalColor;
                /* Compare with default #90a4ae (approximate check) */
                if (fc.getHexString() !== "90a4ae") {
                    defaultColor = "#" + fc.getHexString();
                }
            }

            const activeColor = groupColorOverrides[key] || defaultColor;
            const isVisible = groupVisibility[key] !== false; /* Default true */

            const group = document.createElement('div');
            group.className = 'thread-group';
            if (!isVisible) group.style.opacity = '0.6';

            group.innerHTML = `
                <div class="thread-group-header">
                    <div style="display:flex; align-items:center; gap:8px;">
                        <!-- Eye Icon -->
                        <div class="group-icon group-vis-toggle" title="Toggle Visibility" style="cursor:pointer; opacity:0.9; color:#475569;">
                             ${isVisible ?
                    '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>' :
                    '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M1 1l22 22"/><path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19M14.12 14.12a3 3 0 1 1-4.24-4.24"/></svg>'
                }
                        </div>

                        <input type="color" class="group-color-picker" value="${activeColor}" style="width:24px; height:24px; border:none; padding:0; background:none; cursor:pointer;">
                        <span class="thread-group-title" style="${!isVisible ? 'text-decoration:line-through; color:#888;' : ''}">${key}</span>
                    </div>
                    
                    <div style="display:flex; align-items:center; gap:8px;">
                        <span class="thread-group-count">${faces.length}</span>
                        <!-- X Icon -->
                        <div class="group-icon group-delete-btn" title="Delete Group" style="cursor:pointer; opacity:0.7; color:#f44336; margin-left:8px;">
                            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>
                        </div>
                    </div>
                </div>
                <div class="thread-group-content" style="${!isVisible ? 'display:none;' : ''}">
                    ${faces.map((m, i) => `<div class="thread-item">Face ${i + 1}: ${String(m.userData.faceId).slice(0, 8)}</div>`).join('')}
                </div>
            `;

            /* Bind color picker change */
            const picker = group.querySelector('.group-color-picker');
            picker.addEventListener('input', (e) => {
                e.stopPropagation();
                groupColorOverrides[key] = e.target.value;
                if (isHoleModeActive) applyHoleMode();

                /* Sync to backend */
                const updates = faces.map(f => ({ face_id: f.userData.faceId, color: e.target.value }));
                syncBatchColor(updates);
            });
            picker.addEventListener('click', (e) => e.stopPropagation());

            /* Bind Eye Icon */
            const eyeIcon = group.querySelector('.group-vis-toggle');
            eyeIcon.addEventListener('click', (e) => {
                e.stopPropagation();
                groupVisibility[key] = !isVisible;
                loadHoleManager(); /* Re-render UI */
            });

            /* Bind Delete Icon */
            const delIcon = group.querySelector('.group-delete-btn');
            delIcon.addEventListener('click', (e) => {
                e.stopPropagation();
                deleteThreadGroup(key, faces);
            });

            group.querySelector('.thread-group-header').addEventListener('click', (e) => {
                if (e.target.closest('.group-icon') || e.target === picker) return;
                group.classList.toggle('expanded');
            });
            /* Click item to select face */
            group.querySelectorAll('.thread-item').forEach((item, i) => {
                item.style.cursor = 'pointer';
                item.addEventListener('click', (e) => {
                    e.stopPropagation();
                    deselectAll();
                    selectFace(faces[i], false);
                });
            });
            threadGroups.appendChild(group);
        });
    }

    /* Render hole list (by diameter for cylindrical faces) */
    if (holeData.length === 0) {
        holeList.innerHTML = '<div style="color:#6b7280; font-size:11px; font-style:italic;">No cylindrical faces detected.</div>';
    } else {
        holeList.innerHTML = `<div style="color:#d1d5db; font-size:11px;">${holeData.length} cylindrical face(s) found</div>`;
    }

    clog(`Hole Wizard: ${threadKeys.length} thread types, ${holeData.length} cylinders`, 'info');

    /* Refresh coloring if active (e.g. metadata update) */
    if (isHoleModeActive) applyHoleMode();
}



/* ══════════════════════════════════════════════════
   BOOT TEST
   ══════════════════════════════════════════════════ */
async function bootTest() {
    if (!window.ENABLE_BOOT_TEST) {
        clog("Boot test skipped (not first load)", "info");
        return;
    }
    clog("Boot test starting...", "info");
    try {
        clog("Step 1: Fetching test cube...", "info");
        const resp = await fetch("/test_cube", { method: "POST" });

        clog("Step 2: Parsing response...", "info");
        const data = await resp.json();

        if (!resp.ok) { clog("Boot FAILED: " + (data.error || "unknown"), "err"); return; }

        clog(`Step 3: Building scene with ${data.faces.length} faces...`, "info");
        buildScene(data.faces);

        clog("Boot test COMPLETE", "ok");
    } catch (err) {
        clog("Boot FAILED: " + err.message, "err");
    }
}

/* ══════════════════════════════════════════════════
   PANEL COLLAPSE/EXPAND
   ══════════════════════════════════════════════════ */
const sidebar = document.getElementById("sidebar");
const sidebarPin = document.getElementById("sidebar-pin");
const rpPanel = document.getElementById("right-panel");
// const rpExpandBtn is already declared on line 880 (or earlier), so we use it directly.

if (sidebarPin) {
    sidebarPin.addEventListener("click", () => {
        sidebar.classList.toggle("collapsed");
        const isCollapsed = sidebar.classList.contains("collapsed");
        sidebarPin.innerHTML = isCollapsed
            ? '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 18l6-6-6-6" /></svg>'
            : '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M15 18l-6-6 6-6" /></svg>';
        clog(`Sidebar ${isCollapsed ? "collapsed" : "expanded"}`);
    });
}

if (rpExpandBtn) {
    rpExpandBtn.addEventListener("click", () => {
        rpPanel.classList.toggle("collapsed");
        const isCollapsed = rpPanel.classList.contains("collapsed");
        /* Update Icon: Left (<) if collapsed (to expand), Right (>) if expanded (to collapse) */
        rpExpandBtn.innerHTML = isCollapsed
            ? '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M15 18l-6-6 6-6" /></svg>'
            : '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 18l6-6-6-6" /></svg>';
    });
}

/* ── Load from URL (Persistence) ─────────────────── */
window.addEventListener("DOMContentLoaded", () => {
    const path = window.location.pathname.replace("/", "");
    if (path.length > 5 && /^[a-f0-9]+$/i.test(path)) {
        clog(`Loading model from URL: ${path}...`);
        loading.classList.remove("hidden");
        fetch(`/api/model/${path}?t=${Date.now()}`)
            .then(r => r.json())
            .then(data => {
                if (data.error) { clog("Load error: " + data.error, "err"); return; }
                modelUuid = data.uuid;
                modelUuidEl.textContent = modelUuid;
                buildScene(data.faces);
                dropZone.classList.add('has-file');
                uploadLabel.innerHTML = `Loaded: ${modelUuid.substring(0, 8)}...`;
                clog(`Restored model ${modelUuid}`, "ok");
            })
            .catch(e => clog("Fetch error: " + e.message, "err"))
            .finally(() => loading.classList.add("hidden"));
    } else {
        /* Load Sample Model by default */
        clog("Loading sample model...", "info");
        loading.classList.remove("hidden");
        fetch("/test_sample?t=" + Date.now())
            .then(r => r.json())
            .then(data => {
                if (data.error) { clog("Sample load error: " + data.error, "err"); return; }
                buildScene(data.faces);
                uploadLabel.innerHTML = "Sample Model";
                clog("Loaded sample model", "ok");
            })
            .catch(e => clog("Sample fetch error: " + e.message, "err"))
            .finally(() => loading.classList.add("hidden"));
    }
});

/* ══════════════════════════════════════════════════
   ADMIN TOOLS
   ══════════════════════════════════════════════════ */
window.adminClearMetadata = async (scope = "all") => {
    let msg = "ADMIN: Confirm action?";
    if (scope === "db") msg = "Delete DB metadata for this model? (File untouched)";
    if (scope === "file") msg = "Strip embedded metadata from STEP file? (DB untouched)";
    if (scope === "all") msg = "NUKE EVERYTHING? Delete DB metadata AND strip STEP file?";

    if (!confirm(msg)) return;

    const uuid = modelUuid || "sample";
    clog(`ADMIN: Clearing metadata (${scope}) for ${uuid}...`, "info");

    try {
        const r = await fetch("/api/admin/clear_metadata", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ uuid: uuid, scope: scope })
        });
        const d = await r.json();

        if (!r.ok) throw new Error(d.error || "Unknown error");

        clog(`ADMIN: Success! ${d.message}`, "ok");
        alert(`Success! ${d.message}\n\nModel is now clean in memory.\nYou can EXPORT it now.`);

        // Reset UI instead of reload
        if (modelUuid) {
            // Clear selection
            deselectAll();

            // Visual and Data reset
            faceMeshes.forEach(mesh => {
                mesh.material.color.setHex(0x90a4ae); // DEFAULT_COLOR hex
                if (mesh.userData) {
                    mesh.userData.thread = null;
                    mesh.userData.tolerance = null;
                    if (mesh.userData.originalColor) {
                        mesh.userData.originalColor.setHex(0x90a4ae);
                    }
                }
            });

            // Also clear heat map if active
            if (typeof removeHeatMap === "function") removeHeatMap();

            clog("Visual state reset to defaults.", "info");
        }

    } catch (e) {
        clog("ADMIN FAILED: " + e.message, "err");
        alert("Admin command failed: " + e.message);
    }
};

/* Bind Admin Buttons */
document.querySelectorAll(".admin-action").forEach(btn => {
    btn.addEventListener("click", () => {
        const scope = btn.getAttribute("data-scope");
        window.adminClearMetadata(scope);
    });
});
