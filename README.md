# Pediatric Camp — Health Screening Dashboard

A self-updating dashboard for the Pediatric Camp's school health screening
data. Drop CSV or Excel exports into `data/raw/`, push to GitHub, and a
workflow automatically re-runs the pipeline and republishes the site.

**Live idea in one line:** upload files → GitHub Action filters the
"Pediatric Camp" rows and rebuilds `docs/data/summary.json` → the static
dashboard (already live on GitHub Pages) reads that file and updates.

---

## Project layout

```
pediatric-camp-dashboard/
├── data/
│   └── raw/                  # drop your .csv / .xlsx exports here
├── scripts/
│   └── process_data.py       # the pipeline: filters + aggregates the data
├── docs/                     # the static site (served by GitHub Pages)
│   ├── index.html
│   ├── assets/css/style.css
│   ├── assets/js/app.js
│   └── data/summary.json     # generated — do not hand-edit
├── .github/workflows/pipeline.yml   # runs the pipeline on every push
├── requirements.txt
└── README.md
```

## How the pipeline decides what's "Pediatric Camp" data

The hospital system exports three different shapes of report, and the
pipeline handles all of them:

| Report shape | How camp rows are identified |
|---|---|
| School health screening questionnaire | `Created By` column equals `Pediatric Camp` |
| Dental screening | `Created By` column equals `Pediatric Camp` |
| Vitals detail report | No such column exists here, so a vitals row is kept when its `UHID` matches a child already identified as camp via the two reports above |

Everything else in a file (e.g. regular hospital OPD/IPD visits mixed into
the same vitals export) is dropped. The script re-scans **every** file in
`data/raw/` each run — it doesn't matter if you upload 1 file or 15, in CSV
or Excel format, or mix both.

## Running it yourself

```bash
pip install -r requirements.txt
python scripts/process_data.py
```

This regenerates `docs/data/summary.json`. To preview the site locally:

```bash
cd docs
python -m http.server 8000
# open http://localhost:8000
```

## Setting this up on GitHub

1. Create a new (private, recommended — this is medical data) repository
   and push this project to it:
   ```bash
   git init
   git add .
   git commit -m "Initial pediatric camp dashboard"
   git branch -M main
   git remote add origin <your-repo-url>
   git push -u origin main
   ```
2. In the repo, go to **Settings → Pages** and set **Source** to
   **GitHub Actions**.
3. Go to **Settings → Actions → General → Workflow permissions** and enable
   **Read and write permissions** (the workflow commits the refreshed
   `summary.json` back to the repo).
4. From then on: drop new files into `data/raw/`, commit, and push. The
   `pipeline.yml` workflow will:
   - install Python + pandas,
   - run `scripts/process_data.py`,
   - commit the updated `docs/data/summary.json` if it changed,
   - publish `docs/` to GitHub Pages.

You can also trigger it manually from the **Actions** tab
(`workflow_dispatch`) without pushing new data.

## A note on the data

This is medical/health screening data. Keep the repository **private**
unless every field has been reviewed and cleared for public sharing —
`UHID`, name and mobile number are all present in the raw exports. The
dashboard itself only displays UHID, name, age, gender, BMI and screening
outcomes; it does not display mobile numbers or emails.

## Adding a new report shape later

If the hospital system starts exporting a new template (e.g. a separate
eye-camp report), add a case to `classify()` in `scripts/process_data.py`
and a matching aggregation block — the rest of the pipeline (file
scanning, Pediatric Camp filtering, JSON output) stays the same.
