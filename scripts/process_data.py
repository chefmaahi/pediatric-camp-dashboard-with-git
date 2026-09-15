#!/usr/bin/env python3
"""
Pediatric Camp data pipeline
=============================
Scans data/raw/ for every .csv (and .xlsx) file, keeps only rows that belong
to the "Pediatric Camp", reconciles the three source shapes this hospital
system exports (school health screening, dental screening, vitals), and
writes a single docs/data/summary.json that the static dashboard reads.

Designed to be re-run any number of times, on any number of files, of
either format. New files just get scanned along with everything else --
nothing is hard-coded to a specific filename or file count.
"""
import glob
import json
import os
import re
import sys
from collections import Counter, defaultdict
from datetime import datetime, timezone

import pandas as pd

RAW_DIR = os.path.join(os.path.dirname(__file__), "..", "data", "raw")
OUT_PATH = os.path.join(os.path.dirname(__file__), "..", "docs", "data", "summary.json")

CAMP_MARKER = "pediatric camp"


# --------------------------------------------------------------------------
# Loading helpers
# --------------------------------------------------------------------------
def load_any(path):
    """Read a .csv or .xlsx file (every sheet, if Excel) as a list of DataFrames."""
    ext = os.path.splitext(path)[1].lower()
    frames = []
    try:
        if ext == ".csv":
            frames.append(pd.read_csv(path, dtype=str, keep_default_na=True))
        elif ext in (".xlsx", ".xls"):
            sheets = pd.read_excel(path, dtype=str, sheet_name=None)
            frames.extend(sheets.values())
        else:
            return []
    except Exception as exc:  # noqa: BLE001 - pipeline must not crash on one bad file
        print(f"  ! could not read {path}: {exc}", file=sys.stderr)
        return []
    return frames


def norm_cols(df):
    df = df.copy()
    df.columns = [str(c).strip() for c in df.columns]
    return df


def classify(df):
    """Work out which of the three known report shapes a dataframe is."""
    cols = set(df.columns)
    if "Vital Parameter Name" in cols and "Vital Value" in cols:
        return "vitals"
    if "Template Name" in cols and any("BMI" in c for c in cols) and "Height (cm):" in cols:
        return "screening"
    if "Template Name" in cols and any("Caries" in c for c in cols):
        return "dental"
    return "unknown"


# --------------------------------------------------------------------------
# Cleaning helpers
# --------------------------------------------------------------------------
def parse_age_gender(value):
    """'13 Y,2 D / Female' -> (13, 'Female')."""
    if not isinstance(value, str):
        return None, None
    m = re.match(r"\s*(\d+)\s*Y", value)
    age = int(m.group(1)) if m else None
    gender = None
    if "/" in value:
        gender = value.split("/")[-1].strip()
    return age, gender


def age_band(age):
    if age is None:
        return "Unknown"
    if age <= 5:
        return "0-5"
    if age <= 10:
        return "6-10"
    if age <= 14:
        return "11-14"
    if age <= 18:
        return "15-18"
    return "18+"


def to_num(series):
    return pd.to_numeric(series, errors="coerce")


def sanitize(obj):
    """Recursively replace NaN/NaT and numpy scalar types with plain,
    JSON-safe Python values (float('nan') is not valid JSON)."""
    if obj is None:
        return None
    if isinstance(obj, dict):
        return {(k if not (isinstance(k, float) and pd.isna(k)) else "Unknown"): sanitize(v) for k, v in obj.items()}
    if isinstance(obj, (list, tuple)):
        return [sanitize(v) for v in obj]
    if hasattr(obj, "item"):  # numpy scalar (int64, float64, bool_...)
        obj = obj.item()
    if isinstance(obj, float) and pd.isna(obj):
        return None
    if isinstance(obj, str) and obj.strip().lower() == "nan":
        return None
    return obj


def yes_no_flag(series):
    """Treat 'No' / NaN as no-finding, anything else as a positive finding."""
    s = series.fillna("").astype(str).str.strip()
    return ~s.isin(["", "No", "no", "NO"])


# --------------------------------------------------------------------------
# Main pipeline
# --------------------------------------------------------------------------
def main():
    files = sorted(
        glob.glob(os.path.join(RAW_DIR, "*.csv"))
        + glob.glob(os.path.join(RAW_DIR, "*.xlsx"))
        + glob.glob(os.path.join(RAW_DIR, "*.xls"))
    )
    if not files:
        print("No source files found in data/raw/. Nothing to do.")
        return

    screening_frames, dental_frames, vitals_frames = [], [], []
    files_seen = []

    for path in files:
        for raw in load_any(path):
            df = norm_cols(raw)
            if df.empty or "UHID" not in df.columns:
                continue
            kind = classify(df)
            if kind == "screening":
                screening_frames.append(df)
            elif kind == "dental":
                dental_frames.append(df)
            elif kind == "vitals":
                vitals_frames.append(df)
        files_seen.append(os.path.basename(path))

    screening = pd.concat(screening_frames, ignore_index=True) if screening_frames else pd.DataFrame()
    dental = pd.concat(dental_frames, ignore_index=True) if dental_frames else pd.DataFrame()
    vitals = pd.concat(vitals_frames, ignore_index=True) if vitals_frames else pd.DataFrame()

    # ---- Keep only Pediatric Camp rows ------------------------------------
    if not screening.empty and "Created By" in screening.columns:
        screening = screening[screening["Created By"].fillna("").str.strip().str.lower() == CAMP_MARKER]
    if not dental.empty and "Created By" in dental.columns:
        dental = dental[dental["Created By"].fillna("").str.strip().str.lower() == CAMP_MARKER]

    camp_uhids = set()
    if not screening.empty:
        camp_uhids |= set(screening["UHID"].dropna())
    if not dental.empty:
        camp_uhids |= set(dental["UHID"].dropna())

    # Vitals reports carry no "Created By = Pediatric Camp" marker of their own,
    # so a vitals row belongs to the camp when its UHID matches a camp child.
    if not vitals.empty:
        vitals = vitals[vitals["UHID"].isin(camp_uhids)]

    # De-duplicate repeat template fills, keep the latest per UHID
    if not screening.empty:
        screening = screening.sort_values("Created Date/Time").drop_duplicates("UHID", keep="last")
    if not dental.empty:
        dental = dental.sort_values("Created Date/Time").drop_duplicates("UHID", keep="last")

    total_children = len(camp_uhids)

    # ---- Demographics -------------------------------------------------------
    ages, genders, bands = [], [], []
    for v in screening.get("Age/Gender", pd.Series(dtype=str)):
        age, gender = parse_age_gender(v)
        if age is not None:
            ages.append(age)
            bands.append(age_band(age))
        if gender:
            genders.append(gender)

    gender_counts = Counter(genders)
    band_order = ["0-5", "6-10", "11-14", "15-18", "18+", "Unknown"]
    band_counts = Counter(bands)

    # ---- BMI ------------------------------------------------------------
    bmi_col = "BMI" if "BMI" in screening.columns else None
    bmi_vals = to_num(screening[bmi_col]).dropna() if bmi_col else pd.Series(dtype=float)
    bmi_status_col = "BMI Status:"
    bmi_status_counts = (
        Counter(screening[bmi_status_col].dropna())
        if bmi_status_col in screening.columns
        else Counter()
    )

    # ---- Vision / hearing --------------------------------------------------
    def col_like(df, needle):
        for c in df.columns:
            if needle.lower() in c.lower():
                return c
        return None

    vision_col = col_like(screening, "Distant Vision")
    vision_counts = Counter(screening[vision_col].dropna()) if vision_col else Counter()
    color_vision_col = "Color Vision (Ishihara):"
    color_vision_counts = (
        Counter(screening[color_vision_col].dropna()) if color_vision_col in screening.columns else Counter()
    )

    # ---- Nutrition / illness flags ----------------------------------------
    nutrition_col = "Nutritional & General Health:"
    nutrition_findings = (
        Counter(screening[nutrition_col].dropna()) if nutrition_col in screening.columns else Counter()
    )

    # ---- Dental --------------------------------------------------------
    dental_findings = {}
    dental_flag_cols = [
        "Pit & Fissure Caries:",
        "Dental Caries:",
        "Deep Dental Caries:",
        "Grossly Decayed:",
        "Over Retained tooth:",
        "Calculus",
        "Stains",
        "Flourosis",
    ]
    dental_total = len(dental)
    for c in dental_flag_cols:
        if c in dental.columns:
            dental_findings[c.replace(":", "").strip()] = int(yes_no_flag(dental[c]).sum())

    # ---- Vitals ----------------------------------------------------------
    vitals_summary = {}
    if not vitals.empty:
        vitals = vitals.copy()
        vitals["Vital Value Num"] = to_num(vitals["Vital Value"])
        # keep the latest reading per child per parameter
        if "Vitals Date/Time" in vitals.columns:
            vitals = vitals.sort_values("Vitals Date/Time")
        vitals_latest = vitals.drop_duplicates(["UHID", "Vital Parameter Name"], keep="last")

        for param, grp in vitals_latest.groupby("Vital Parameter Name"):
            nums = grp["Vital Value Num"].dropna()
            nums = nums[nums > 0]  # drop obvious zero/placeholder entries
            if nums.empty:
                continue
            vitals_summary[param] = {
                "count": int(nums.count()),
                "avg": round(float(nums.mean()), 1),
                "min": round(float(nums.min()), 1),
                "max": round(float(nums.max()), 1),
            }

    # ---- Referral / risk flags ---------------------------------------------
    referral_col = "Referral Needed: "
    referral_count = (
        int(yes_no_flag(screening[referral_col]).sum()) if referral_col in screening.columns else 0
    )

    # ---- Build children table for the searchable list ----------------------
    children = []
    dental_by_uhid = dental.set_index("UHID") if not dental.empty and "UHID" in dental.columns else pd.DataFrame()
    for _, row in screening.iterrows():
        age, gender = parse_age_gender(row.get("Age/Gender"))
        uhid = row.get("UHID")
        has_dental = uhid in dental_by_uhid.index if not dental_by_uhid.empty else False
        bmi_val = None
        if bmi_col:
            raw_bmi = pd.to_numeric(row.get(bmi_col), errors="coerce")
            if pd.notna(raw_bmi):
                bmi_val = round(float(raw_bmi), 1)
        children.append(
            {
                "uhid": uhid,
                "name": row.get("Patient Name"),
                "age": age,
                "gender": gender,
                "ageBand": age_band(age),
                "bmi": bmi_val,
                "bmiStatus": row.get(bmi_status_col) if bmi_status_col in screening.columns else None,
                "vision": row.get(vision_col) if vision_col else None,
                "dentalScreened": bool(has_dental),
            }
        )

    # ---- Assemble summary ---------------------------------------------------
    summary = {
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "sourceFiles": files_seen,
        "kpis": {
            "totalChildren": total_children,
            "screened": len(screening),
            "dentalScreened": dental_total,
            "vitalsRecorded": vitals["UHID"].nunique() if not vitals.empty else 0,
            "avgBMI": round(float(bmi_vals.mean()), 1) if not bmi_vals.empty else None,
            "underweightPct": round(
                100 * bmi_status_counts.get("Underweight", 0) / max(len(screening), 1), 1
            ),
            "visionIssues": vision_counts.get("Deficient", 0),
            "referralsNeeded": referral_count,
        },
        "demographics": {
            "gender": dict(gender_counts),
            "ageBands": {b: band_counts.get(b, 0) for b in band_order if band_counts.get(b, 0)},
        },
        "bmi": {
            "status": dict(bmi_status_counts),
            "distribution": [round(v, 1) for v in bmi_vals.tolist()],
        },
        "vision": {
            "distantVision": dict(vision_counts),
            "colorVision": dict(color_vision_counts),
        },
        "nutrition": dict(nutrition_findings),
        "dental": {
            "totalScreened": dental_total,
            "findings": dental_findings,
        },
        "vitals": vitals_summary,
        "children": children,
    }

    summary = sanitize(summary)

    os.makedirs(os.path.dirname(OUT_PATH), exist_ok=True)
    with open(OUT_PATH, "w", encoding="utf-8") as f:
        json.dump(summary, f, indent=2, default=str, allow_nan=False)

    print(f"Processed {len(files_seen)} source file(s): {', '.join(files_seen)}")
    print(f"Pediatric Camp children found: {total_children}")
    print(f"Wrote {OUT_PATH}")


if __name__ == "__main__":
    main()
