
"""
Flask app for loading STEP files with XDE (Extended Data Exchange).
"""
import logging
import mimetypes
import os
import re
import uuid
import tempfile

# Fix Windows serving .js as text/plain
mimetypes.add_type("application/javascript", ".js")
mimetypes.add_type("text/css", ".css")
from logging.handlers import RotatingFileHandler
from flask import Flask, render_template, request, jsonify, send_file

# ── Core Modules ─────────────────────────────────────────────────────────────
from core.state import model
from core.loader import load_step_xcaf
from core.utils import hex_to_quantity
from core.exporter import export_step_xcaf

# ── OCP imports needed for routes ───────────────────────────────────────────
from OCP.XCAFDoc import XCAFDoc_ColorSurf
from OCP.BRepAdaptor import BRepAdaptor_Surface
from OCP.GeomAbs import GeomAbs_Cylinder

# ── Geometry fingerprinting + SQLite persistence ─────────────────────────────
from face_db import save_face_meta, get_db_stats, init_db

# Initialize DB (create tables if missing)
try:
    init_db()
except Exception as e:
    logging.error(f"Failed to init DB: {e}")

# ── Flask setup ──────────────────────────────────────────────────────────────
app = Flask(__name__)
app.config["UPLOAD_FOLDER"] = os.path.join(os.path.dirname(__file__), "uploads")
os.makedirs(app.config["UPLOAD_FOLDER"], exist_ok=True)

# ── Logging setup ────────────────────────────────────────────────────────────
log_file = os.path.join(os.path.dirname(os.path.abspath(__file__)), "server_logs.txt")
file_handler = RotatingFileHandler(log_file, maxBytes=5*1024*1024, backupCount=3)
file_handler.setLevel(logging.INFO)
file_handler.setFormatter(logging.Formatter(
    '%(asctime)s %(levelname)s: %(message)s [in %(pathname)s:%(lineno)d]'
))
app.logger.addHandler(file_handler)
app.logger.setLevel(logging.INFO)

werkzeug_logger = logging.getLogger('werkzeug')
werkzeug_logger.addHandler(file_handler)
werkzeug_logger.setLevel(logging.INFO)

app.logger.info("Flask server starting up")


# ── Routes ───────────────────────────────────────────────────────────────────

FIRST_BOOT = True
APP_VERSION = 1

@app.route("/")
def index():
    global FIRST_BOOT
    do_test = FIRST_BOOT
    FIRST_BOOT = False
    return render_template("index.html", boot_test=do_test, version=APP_VERSION)


@app.route("/upload", methods=["POST"])
def upload():
    if "file" not in request.files:
        return jsonify({"error": "No file part"}), 400

    f = request.files["file"]
    if f.filename == "":
        return jsonify({"error": "No selected file"}), 400

    ext = os.path.splitext(f.filename)[1].lower()
    if ext not in (".step", ".stp"):
        return jsonify({"error": "Only .step / .stp files are supported"}), 400

    save_name = f"{uuid.uuid4().hex}.step"
    save_path = os.path.join(app.config["UPLOAD_FOLDER"], save_name)
    f.save(save_path)
    model.original_filename = os.path.splitext(f.filename)[0]
    
    # Store UUID based on filename
    model.model_uuid = os.path.splitext(save_name)[0]

    try:
        faces = load_step_xcaf(save_path)
    except Exception as e:
        app.logger.error(f"Upload failed: {e}", exc_info=True)
        model.reset()
        if os.path.exists(save_path): os.remove(save_path)
        return jsonify({"error": str(e)}), 500

    # Don't delete file - keep for persistence
    return jsonify({"faces": faces, "uuid": model.model_uuid})

@app.route("/<uuid_str>")
def view_model(uuid_str):
    """Serve the viewer for a specific model UUID."""
    return render_template("index.html", boot_test=False, version=APP_VERSION)

@app.route("/api/model/<uuid_str>")
def get_model(uuid_str):
    """Retrieve face data for a persisted model."""
    path = os.path.join(app.config["UPLOAD_FOLDER"], f"{uuid_str}.step")
    if not os.path.exists(path):
        return jsonify({"error": "Model not found"}), 404
        
    try:
        # Load the specific file into the global model object (single user limitation accepted)
        model.reset()
        model.model_uuid = uuid_str
        faces = load_step_xcaf(path)
        return jsonify({"faces": faces, "uuid": uuid_str})
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.route("/set_color", methods=["POST"])
def set_color():
    if model.doc is None:
        return jsonify({"error": "No model loaded"}), 400

    data = request.get_json()
    updates = data.get("updates")
    
    # Backward compatibility for single update
    if updates is None:
        updates = [{"face_id": data.get("face_id"), "color": data.get("color")}]

    db_updated_count = 0
    
    for item in updates:
        face_id = item.get("face_id")
        hex_color = item.get("color")

        if face_id is None or hex_color is None: continue
        if face_id < 0 or face_id >= len(model.face_shapes): continue

        try:
            q_color = hex_to_quantity(hex_color)
            face_label = model.face_labels[face_id]
            face_shape = model.face_shapes[face_id]
            if face_label is not None and not face_label.IsNull():
                model.color_tool.SetColor(face_label, q_color, XCAFDoc_ColorSurf)
            else:
                model.color_tool.SetColor(face_shape, q_color, XCAFDoc_ColorSurf)

            # ── Persist to Metadata & DB ────────────────────────────────────
            model.face_meta.setdefault(face_id, {})["color"] = hex_color
            
            if face_id < len(model.face_hashes):
                fh = model.face_hashes[face_id]
                raw = model.face_raws[face_id] if face_id < len(model.face_raws) else None
                if fh and fh != "unknown":
                    meta = model.face_meta.get(face_id, {})
                    if meta:
                        save_face_meta(fh, meta, raw=raw)
                        db_updated_count += 1

        except Exception as e:
            print(f"Error setting color for face {face_id}: {e}")
            continue

    return jsonify({"ok": True, "db_updated_count": db_updated_count})


@app.route("/export", methods=["GET"])
def export_step():
    """Re-export STEP with colours (XDE) + metadata (comment block)."""
    if model.doc is None:
        return jsonify({"error": "No model loaded"}), 400

    try:
        filename, mimetype, file_stream = export_step_xcaf(app.config["UPLOAD_FOLDER"])
        
        # User requested UUID as filename
        out_name = filename
        if model.model_uuid:
            out_name = f"{model.model_uuid}.step"
            
        return send_file(
            file_stream,
            as_attachment=True,
            download_name=out_name,
            mimetype=mimetype,
        )
    except Exception as e:
        return jsonify({"error": str(e)}), 500
    

@app.route("/set_thread", methods=["POST"])
def set_thread():
    """Store thread metadata for a face (batch support)."""
    if model.doc is None:
        return jsonify({"error": "No model loaded"}), 400

    data = request.get_json()
    updates = data.get("updates")
    
    if updates is None:
        updates = [{"face_id": data.get("face_id"), "thread": data.get("thread")}]

    db_updated_count = 0

    for item in updates:
        face_id = item.get("face_id")
        thread = item.get("thread")

        if face_id is None: continue
        if face_id < 0 or face_id >= len(model.face_shapes): continue

        if thread:
            model.face_meta.setdefault(face_id, {})["thread"] = {
                "type":  thread.get("type", ""),
                "size":  thread.get("size", ""),
                "pitch": thread.get("pitch", ""),
                "class": thread.get("class", ""),
            }
        else:
            if face_id in model.face_meta:
                model.face_meta[face_id].pop("thread", None)
                if not model.face_meta[face_id]:
                    del model.face_meta[face_id]

        # ── Persist to SQLite by geometry hash
        if face_id < len(model.face_hashes):
            fh = model.face_hashes[face_id]
            raw = model.face_raws[face_id] if face_id < len(model.face_raws) else None
            if fh and fh != "unknown":
                meta = model.face_meta.get(face_id, {})
                if meta:
                    save_face_meta(fh, meta, raw=raw)
                    db_updated_count += 1

    return jsonify({"ok": True, "db_updated_count": db_updated_count})


@app.route("/thread_options", methods=["GET"])
def thread_options():
    """Return the standard option lists for thread dropdowns."""
    return jsonify({
        "types": [
            "None", "UNC (Unified Coarse)", "UNF (Unified Fine)", "M (ISO Metric)",
            "MF (ISO Metric Fine)", "STI (Helicoil Insert)", "Keensert",
            "UNEF (Unified Extra Fine)", "BSW (British Whitworth)", "BSF (British Fine)",
            "NPT (National Pipe Taper)", "NPTF (Dryseal Pipe)", "BSPT (British Pipe Taper)",
            "BSPP (British Pipe Parallel)", "Tr (Trapezoidal)", "ACME", "Buttress", "Custom",
        ],
        "sizes": {
             "M (ISO Metric)": [
                "M1", "M1.2", "M1.4", "M1.6", "M2", "M2.5", "M3", "M4", "M5",
                "M6", "M8", "M10", "M12", "M14", "M16", "M18", "M20", "M22",
                "M24", "M27", "M30", "M33", "M36", "M39", "M42", "M48", "M56", "M64",
            ],
            "MF (ISO Metric Fine)": [
                "M8x1", "M10x1", "M10x1.25", "M12x1.25", "M12x1.5",
                "M14x1.5", "M16x1.5", "M18x1.5", "M20x1.5", "M20x2",
                "M22x1.5", "M24x2", "M27x2", "M30x2", "M33x2", "M36x3",
            ],
            "UNC (Unified Coarse)": [
                "#0-80", "#1-64", "#2-56", "#3-48", "#4-40", "#5-40",
                "#6-32", "#8-32", "#10-24", "#12-24",
                "1/4-20", "5/16-18", "3/8-16", "7/16-14", "1/2-13",
                "9/16-12", "5/8-11", "3/4-10", "7/8-9", "1-8",
                "1-1/8-7", "1-1/4-7", "1-3/8-6", "1-1/2-6",
                "1-3/4-5", "2-4.5",
            ],
            "UNF (Unified Fine)": [
                "#0-80", "#1-72", "#2-64", "#3-56", "#4-48", "#5-44",
                "#6-40", "#8-36", "#10-32", "#12-28",
                "1/4-28", "5/16-24", "3/8-24", "7/16-20", "1/2-20",
                "9/16-18", "5/8-18", "3/4-16", "7/8-14", "1-12",
                "1-1/8-12", "1-1/4-12", "1-1/2-12",
            ],
            "UNEF (Unified Extra Fine)": [
                "1/4-32", "5/16-32", "3/8-32", "7/16-28", "1/2-28",
                "9/16-24", "5/8-24", "3/4-20", "7/8-20", "1-20",
            ],
            "STI (Helicoil Insert)": [
                "#2-56", "#4-40", "#6-32", "#8-32", "#10-24", "#10-32",
                "1/4-20", "1/4-28", "5/16-18", "5/16-24",
                "3/8-16", "3/8-24", "7/16-14", "7/16-20",
                "1/2-13", "1/2-20", "5/8-11", "5/8-18",
                "3/4-10", "3/4-16", "M3x0.5", "M4x0.7", "M5x0.8",
                "M6x1", "M8x1.25", "M10x1.5", "M12x1.75",
            ],
            "Keensert": [
                "#4-40", "#6-32", "#8-32", "#10-24", "#10-32",
                "1/4-20", "1/4-28", "5/16-18", "5/16-24",
                "3/8-16", "3/8-24", "7/16-14", "7/16-20",
                "1/2-13", "1/2-20", "5/8-11", "5/8-18",
                "3/4-10", "3/4-16", "M5x0.8", "M6x1", "M8x1.25",
                "M10x1.5", "M12x1.75",
            ],
            "BSW (British Whitworth)": [
                "1/16", "3/32", "1/8", "5/32", "3/16", "7/32", "1/4", "5/16",
                "3/8", "7/16", "1/2", "5/8", "3/4", "7/8", "1",
            ],
            "BSF (British Fine)": [
                "3/16", "7/32", "1/4", "5/16", "3/8", "7/16", "1/2",
                "9/16", "5/8", "3/4", "7/8", "1",
            ],
            "NPT (National Pipe Taper)": [
                "1/16", "1/8", "1/4", "3/8", "1/2", "3/4", "1", "1-1/4", "1-1/2", "2",
            ],
            "NPTF (Dryseal Pipe)": [
                "1/16", "1/8", "1/4", "3/8", "1/2", "3/4", "1", "1-1/4", "1-1/2", "2",
            ],
            "BSPT (British Pipe Taper)": [
                "1/16", "1/8", "1/4", "3/8", "1/2", "3/4", "1", "1-1/4", "1-1/2", "2",
            ],
            "BSPP (British Pipe Parallel)": [
                "1/16", "1/8", "1/4", "3/8", "1/2", "3/4", "1", "1-1/4", "1-1/2", "2",
            ],
        },
        "pitches": {
            "M (ISO Metric)": [
                "0.25", "0.3", "0.35", "0.4", "0.45", "0.5", "0.6", "0.7",
                "0.75", "0.8", "1.0", "1.25", "1.5", "1.75", "2.0", "2.5",
                "3.0", "3.5", "4.0", "4.5", "5.0", "5.5", "6.0",
            ],
            "MF (ISO Metric Fine)": [
                "0.2", "0.25", "0.35", "0.5", "0.75", "1.0", "1.25", "1.5", "2.0", "3.0",
            ],
            "UNC (Unified Coarse)": [
                "80 TPI", "72 TPI", "64 TPI", "56 TPI", "48 TPI", "44 TPI",
                "40 TPI", "32 TPI", "24 TPI", "20 TPI", "18 TPI", "16 TPI",
                "14 TPI", "13 TPI", "12 TPI", "11 TPI", "10 TPI", "9 TPI",
                "8 TPI", "7 TPI", "6 TPI", "5 TPI", "4.5 TPI", "4 TPI",
            ],
            "UNF (Unified Fine)": [
                "80 TPI", "72 TPI", "64 TPI", "56 TPI", "48 TPI", "44 TPI",
                "40 TPI", "36 TPI", "32 TPI", "28 TPI", "24 TPI", "20 TPI",
                "18 TPI", "16 TPI", "14 TPI", "12 TPI",
            ],
            "NPT (National Pipe Taper)": [
                "27 TPI", "18 TPI", "14 TPI", "11.5 TPI", "8 TPI",
            ],
        },
        "classes": [
            "None",
            "1A / 1B (Loose)",
            "2A / 2B (Standard)",
            "3A / 3B (Tight)",
            "4g6g / 6H (ISO Loose)",
            "6g / 6H (ISO Medium)",
            "4h6h / 5H (ISO Close)",
            "6e / 6H (ISO Sliding)",
            "Interference",
            "Custom",
        ],
    })


@app.route("/get_holes", methods=["GET"])
def get_holes():
    """Analyze model and return grouped holes (cylindrical faces)."""
    if model.doc is None: return jsonify({"error": "No model loaded"}), 400
    
    holes = []
    # Simple hole detection: find all faces that are cylindrical
    # Refinement: check if internal (concave)? XDE doesn't give this easily without topology analysis.
    # For now, we list all cylindrical surfaces.
    
    # helper to check if cylinder
    def get_cylinder_info(face_shape):
        surf = BRepAdaptor_Surface(face_shape, True) # True = restriction to face
        if surf.GetType() == GeomAbs_Cylinder:
            cyl = surf.Cylinder()
            r = cyl.Radius()
            return {"type": "cylinder", "diameter": round(r * 2, 4)}
        return None

    grouped = {} # diameter -> list of face_ids

    for i, shape in enumerate(model.face_shapes):
        info = get_cylinder_info(shape)
        if info:
            d = info["diameter"]
            grouped.setdefault(d, []).append(i)

    # Format for frontend: list of groups
    # [{diameter: 10.0, ids: [1, 2, 3], count: 3}, ...]
    result = []
    for d, ids in grouped.items():
        result.append({"diameter": d, "ids": ids, "count": len(ids)})
    
    # Sort by diameter
    result.sort(key=lambda x: x["diameter"])
    
    return jsonify({"holes": result})

@app.route("/set_tolerance", methods=["POST"])
def set_tolerance():
    """Store tolerance metadata for a face (batch support)."""
    if model.doc is None: return jsonify({"error": "No model loaded"}), 400

    data = request.get_json()
    updates = data.get("updates")
    
    if updates is None:
        updates = [{"face_id": data.get("face_id"), "tolerance": data.get("tolerance")}]

    db_updated_count = 0

    for item in updates:
        face_id = item.get("face_id")
        tol = item.get("tolerance")

        if face_id is None: continue
        if face_id < 0 or face_id >= len(model.face_shapes): continue

        if tol:
            model.face_meta.setdefault(face_id, {})["tolerance"] = {
                "type": tol.get("type", ""),
                "value": tol.get("value", ""),
                "datum": tol.get("datum", ""),
            }
        else:
            if face_id in model.face_meta:
                model.face_meta[face_id].pop("tolerance", None)
                if not model.face_meta[face_id]: del model.face_meta[face_id]

        # Persist to SQLite
        if face_id < len(model.face_hashes):
            fh = model.face_hashes[face_id]
            if fh and fh != "unknown":
                meta = model.face_meta.get(face_id, {})
                if meta:
                    save_face_meta(fh, meta, raw=model.face_raws[face_id] if face_id < len(model.face_raws) else None)
                    db_updated_count += 1

    return jsonify({"ok": True, "db_updated_count": db_updated_count})

@app.route("/tolerance_options", methods=["GET"])
def tolerance_options():
    """Return standard tolerance options."""
    return jsonify({
        "types": [
            "None", "Linear +/-", "Limit", "Geometric (GD&T)", 
            "Position", "Flatness", "Parallelism", "Perpendicularity", 
            "Concentricity", "H7 (Hole)", "H8 (Hole)", "H9 (Hole)", 
            "g6 (Shaft)", "f7 (Shaft)", "h6 (Shaft)", "h7 (Shaft)", 
            "Custom"
        ],
        "values": [
            "None", 
            "+/- 0.0005", "+/- 0.001", "+/- 0.002", "+/- 0.003", "+/- 0.005",
            "+/- 0.010", "+/- 0.015", "+/- 0.020", "+/- 0.030",
            "+0.000/-0.001", "+0.001/-0.000", "+0.000/-0.005", "+0.005/-0.000",
            "0.001 TIR", "0.002 TIR", "0.005 TIR", "0.010 TIR"
        ]
    })

@app.route("/db_stats", methods=["GET"])
def db_stats():
    """Return geometry DB statistics."""
    return jsonify(get_db_stats())


@app.route("/test_cube", methods=["POST"])
def test_cube():
    try:
        import cadquery as cq
        tmp = tempfile.NamedTemporaryFile(suffix=".step", delete=False)
        tmp_path = tmp.name
        tmp.close()
        box = cq.Workplane("XY").box(20, 20, 20)
        cq.exporters.export(box, tmp_path)
        model.original_filename = "test_cube"
        faces = load_step_xcaf(tmp_path)
    except Exception as e:
        return jsonify({"error": str(e)}), 500
    finally:
        if "tmp_path" in locals() and os.path.exists(tmp_path):
            os.remove(tmp_path)
    return jsonify({"faces": faces})


@app.route("/mockups")
def mockups():
    """Serve the feature mockups page."""
    return render_template("mockups.html")

@app.route('/test_sample', methods=['GET'])
def test_sample():
    """Loads tests/sample.step directly."""
    sample_path = os.path.join(app.root_path, 'tests', 'sample.step')
    if not os.path.exists(sample_path):
        return jsonify({"error": "Sample file not found"}), 404
        
    try:
        model.original_filename = "sample"
        model.model_uuid = "sample"
        faces = load_step_xcaf(sample_path)
        return jsonify({"faces": faces, "filename": "sample.step"})
    except Exception as e:
        print(f"Sample load error: {e}")
        return jsonify({"error": str(e)}), 500


@app.route("/api/admin/clear_metadata", methods=["POST"])
def admin_clear_metadata():
    """
    ADMIN TOOL — Nuke metadata from DB, STEP file, and/or in-memory state.

      scope="db"   -> Delete DB metadata + clear in-memory state
      scope="file" -> Strip all 3 metadata strategies from STEP file + clear in-memory state
      scope="all"  -> Do both

    The in-memory state (model.face_meta) is ALWAYS cleared regardless of scope,
    because otherwise a subsequent Export would re-inject the metadata right back
    into the file via inject_meta_into_step().
    """
    data = request.get_json()
    target_uuid = data.get("uuid")
    scope = data.get("scope", "all")

    if not target_uuid:
        return jsonify({"error": "UUID required"}), 400

    # Ensure model is loaded (if different from current)
    if model.model_uuid != target_uuid:
        try:
            model.reset()
            model.model_uuid = target_uuid
            load_path = os.path.join(app.config["UPLOAD_FOLDER"], f"{target_uuid}.step")
            if not os.path.exists(load_path) and target_uuid == "sample":
                load_path = os.path.join(app.root_path, 'tests', 'sample.step')
            if not os.path.exists(load_path):
                return jsonify({"error": "Model not found on server"}), 404
            load_step_xcaf(load_path)
        except Exception as e:
            return jsonify({"error": f"Failed to load model: {e}"}), 500

    deleted_count = 0
    message_parts = []

    # ── 1. Database cleanup ──────────────────────────────────────────────
    if scope in ("db", "all"):
        if scope == "all":
            from face_db import clear_database
            clear_database()
            message_parts.append("Deleted ALL DB entries (global wipe)")
        else:
            from face_db import delete_faces
            hashes_to_delete = [h for h in model.face_hashes if h and h != "unknown"]
            delete_faces(hashes_to_delete)
            deleted_count = len(hashes_to_delete)
            message_parts.append(f"Deleted {deleted_count} DB entries")

    # ── 2. STEP file cleanup ─────────────────────────────────────────────
    if scope in ("file", "all"):
        file_path = os.path.join(app.config["UPLOAD_FOLDER"], f"{target_uuid}.step")
        if not os.path.exists(file_path) and target_uuid == "sample":
            file_path = os.path.join(app.root_path, 'tests', 'sample.step')

        if not os.path.exists(file_path):
            print(f"[ADMIN] File not found: {file_path}")
            return jsonify({"error": "STEP file not found on server"}), 404

        # Verify BEFORE
        from core.metadata import extract_meta_from_step
        before_meta = extract_meta_from_step(file_path)
        print(f"[ADMIN] Metadata BEFORE cleanup: {list(before_meta.keys())} ({len(before_meta)} keys)")

        with open(file_path, "rb") as f:
            content = f.read().decode("utf-8", errors="replace")
        original_len = len(content)

        # Strategy 2: Strip [SVFM:<base64>] tags from PRODUCT description
        content = re.sub(r"\[SVFM:.*?\]", "", content, flags=re.DOTALL)

        # Strategy 3: Strip /* __STEPVIEWER_META_START__ ... */ comment blocks
        content = re.sub(
            r"/\* __STEPVIEWER_META_START__ .*? __STEPVIEWER_META_END__ \*/",
            "", content, flags=re.DOTALL
        )

        # Strategy 1: Blank the payload in DESCRIPTIVE_REPRESENTATION_ITEM('SVFM'|'StepViewerFaceMetadata', '<payload>')
        # We clear the payload to '' rather than removing the entity, which preserves valid STEP structure.
        entity_pattern = (
            r"(DESCRIPTIVE_REPRESENTATION_ITEM\s*\(\s*'"
            r"(?:SVFM|StepViewerFaceMetadata)"
            r"'\s*,\s*')[^']*('\s*\))"
        )
        content = re.sub(entity_pattern, r"\1\2", content, flags=re.DOTALL)

        stripped_chars = original_len - len(content)
        with open(file_path, "wb") as f:
            f.write(content.encode("utf-8"))

        # Verify AFTER
        after_meta = extract_meta_from_step(file_path)
        if after_meta:
            print(f"[ADMIN] WARNING: Metadata STILL detected after cleanup: {list(after_meta.keys())}")
        else:
            print(f"[ADMIN] SUCCESS: File is clean ({stripped_chars} chars removed)")

        message_parts.append(f"Stripped STEP file ({stripped_chars} chars removed)")

    # ── 3. ALWAYS clear in-memory state ──────────────────────────────────
    # This is critical: if model.face_meta is not cleared, a subsequent
    # Export call will call inject_meta_into_step() and re-embed metadata.
    model.face_meta = {}
    message_parts.append("Cleared in-memory metadata")
    print(f"[ADMIN] In-memory model.face_meta cleared ({scope})")

    return jsonify({
        "ok": True,
        "deleted_count": deleted_count,
        "message": " & ".join(message_parts)
    })

if __name__ == "__main__":
    app.run(debug=True, port=5555)
