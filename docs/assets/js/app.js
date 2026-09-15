/* Pediatric Camp Dashboard — client logic
   Loads docs/data/summary.json (built by scripts/process_data.py), then
   drives the KPI cards, charts, slicers and the children table entirely
   client-side. No build step required. */

(function () {
  "use strict";

  const COLORS = {
    teal: "#0F6E63",
    tealSoft: "#5AA79C",
    tealTint: "#BFE0DA",
    blue: "#2D6E8E",
    blueTint: "#AFCFDE",
    coral: "#DD5C3C",
    coralTint: "#F3B7A4",
    amber: "#B9822C",
    amberTint: "#E6C88C",
    ink: "#4C5B56",
    grid: "#E1EAE7",
  };

  Chart.defaults.font.family = "Inter, sans-serif";
  Chart.defaults.color = COLORS.ink;
  Chart.defaults.plugins.legend.labels.usePointStyle = true;
  Chart.defaults.plugins.legend.labels.boxWidth = 8;

  if (typeof ChartDataLabels !== "undefined") {
    Chart.register(ChartDataLabels);
  }
  Chart.defaults.set("plugins.datalabels", {
    color: COLORS.ink,
    font: { weight: 600, size: 11 },
  });

  const state = {
    data: null,
    filters: { gender: "all", age: "all" },
    search: "",
    page: 1,
    pageSize: 10,
    charts: {},
  };

  fetch("data/summary.json")
    .then((r) => {
      if (!r.ok) throw new Error("summary.json not found");
      return r.json();
    })
    .then((data) => {
      state.data = data;
      init(data);
    })
    .catch((err) => {
      console.error(err);
      const main = document.querySelector("main");
      main.innerHTML =
        '<div class="alert alert-warning mt-4">Could not load camp data (docs/data/summary.json). Run <code>python scripts/process_data.py</code> to generate it.</div>';
    });

  function init(data) {
    document.getElementById("generatedAt").textContent = formatDate(data.generatedAt);
    document.getElementById("sourceFileCount").textContent = data.sourceFiles.length;
    document.getElementById("dentalTotalNote").textContent = data.dental.totalScreened;

    animateCount(document.getElementById("heroCount"), data.kpis.totalChildren);
    document.getElementById("heroDentalNote").textContent = data.kpis.dentalScreened;
    document.getElementById("heroVitalsNote").textContent = data.kpis.vitalsRecorded;

    bindFilters();
    bindTableControls();
    render();
  }

  function formatDate(iso) {
    try {
      const d = new Date(iso);
      return d.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
    } catch (e) {
      return iso;
    }
  }

  function animateCount(el, target) {
    const duration = 900;
    const start = performance.now();
    function tick(now) {
      const p = Math.min(1, (now - start) / duration);
      const eased = 1 - Math.pow(1 - p, 3);
      el.textContent = Math.round(eased * target);
      if (p < 1) requestAnimationFrame(tick);
    }
    requestAnimationFrame(tick);
  }

  // ---------------------------------------------------------------- filters
  function bindFilters() {
    document.querySelectorAll(".filter-chip").forEach((btn) => {
      btn.addEventListener("click", () => {
        const group = btn.closest(".btn-group");
        group.querySelectorAll(".filter-chip").forEach((b) => b.classList.remove("active"));
        btn.classList.add("active");
        state.filters[btn.dataset.filter] = btn.dataset.value;
        state.page = 1;
        render();
      });
    });
    document.getElementById("resetFilters").addEventListener("click", () => {
      state.filters = { gender: "all", age: "all" };
      state.page = 1;
      document.querySelectorAll(".filter-chip").forEach((b) => {
        b.classList.toggle("active", b.dataset.value === "all");
      });
      render();
    });
  }

  function bindTableControls() {
    document.getElementById("tableSearch").addEventListener("input", (e) => {
      state.search = e.target.value.trim().toLowerCase();
      state.page = 1;
      renderTable();
    });
    document.getElementById("prevPage").addEventListener("click", () => {
      if (state.page > 1) {
        state.page -= 1;
        renderTable();
      }
    });
    document.getElementById("nextPage").addEventListener("click", () => {
      state.page += 1;
      renderTable();
    });
  }

  function getFilteredChildren() {
    const { gender, age } = state.filters;
    return state.data.children.filter((c) => {
      if (gender !== "all" && c.gender !== gender) return false;
      if (age !== "all" && c.ageBand !== age) return false;
      return true;
    });
  }

  // --------------------------------------------------------------- render
  function render() {
    const children = getFilteredChildren();
    renderKPIs(children);
    renderAgeGenderChart(children);
    renderGenderChart(children);
    renderBmiStatusChart(children);
    renderBmiHistChart(children);
    renderVisionChart(children);
    renderDentalChart(); // camp-wide (per-condition breakdown isn't per-child in source data)
    renderTable();
  }

  function renderKPIs(children) {
    const total = children.length;
    const underweight = children.filter((c) => c.bmiStatus === "Underweight").length;
    const overweight = children.filter((c) => c.bmiStatus === "Overweight").length;
    const visionIssues = children.filter((c) => c.vision === "Deficient").length;
    const dentalDone = children.filter((c) => c.dentalScreened).length;

    setKpi("totalChildren", total);
    setKpi("overweightPct", total ? Math.round((100 * overweight) / total) + "%" : "0%");
    setKpi("underweightPct", total ? Math.round((100 * underweight) / total) + "%" : "0%");
    setKpi("visionIssues", visionIssues);
    setKpi("dentalScreened", dentalDone);
    setKpi("vitalsRecorded", state.data.kpis.vitalsRecorded); // vitals not joined per-filter in source
  }

  function setKpi(key, value) {
    const el = document.querySelector(`[data-kpi="${key}"]`);
    if (!el) return;
    el.textContent = value;
    el.classList.remove("count-up");
    void el.offsetWidth; // restart animation
    el.classList.add("count-up");
  }

  function upsertChart(id, config) {
    if (state.charts[id]) {
      state.charts[id].data = config.data;
      state.charts[id].options = config.options;
      state.charts[id].update();
      return;
    }
    const ctx = document.getElementById(id).getContext("2d");
    state.charts[id] = new Chart(ctx, config);
  }

  function renderAgeGenderChart(children) {
    const bands = ["0-5", "6-10", "11-14", "15-18", "18+"];
    const girls = bands.map((b) => children.filter((c) => c.ageBand === b && c.gender === "Female").length);
    const boys = bands.map((b) => children.filter((c) => c.ageBand === b && c.gender === "Male").length);
    upsertChart("ageGenderChart", {
      type: "bar",
      data: {
        labels: bands,
        datasets: [
          { label: "Girls", data: girls, backgroundColor: COLORS.coralTint, borderRadius: 4, maxBarThickness: 34 },
          { label: "Boys", data: boys, backgroundColor: COLORS.blueTint, borderRadius: 4, maxBarThickness: 34 },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        scales: {
          x: { stacked: false, grid: { display: false } },
          y: { beginAtZero: true, grid: { color: COLORS.grid }, ticks: { precision: 0 } },
        },
        plugins: {
          legend: { position: "top", align: "end" },
          datalabels: {
            anchor: "end",
            align: "top",
            formatter: (v) => (v ? v : ""),
          },
        },
      },
    });
  }

  function renderGenderChart(children) {
    const counts = {};
    children.forEach((c) => {
      const g = c.gender || "Unspecified";
      counts[g] = (counts[g] || 0) + 1;
    });
    upsertChart("genderChart", {
      type: "doughnut",
      data: {
        labels: Object.keys(counts),
        datasets: [{ data: Object.values(counts), backgroundColor: [COLORS.coral, COLORS.blue, COLORS.amber], borderWidth: 0 }],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        cutout: "68%",
        plugins: {
          legend: { position: "bottom" },
          datalabels: {
            color: "#fff",
            formatter: (v, ctx) => {
              const total = ctx.dataset.data.reduce((a, b) => a + b, 0);
              return total ? `${v}\n${Math.round((100 * v) / total)}%` : v;
            },
          },
        },
      },
    });
  }

  function renderBmiStatusChart(children) {
    const order = ["Underweight", "Normal", "Overweight"];
    const counts = order.map((s) => children.filter((c) => c.bmiStatus === s).length);
    upsertChart("bmiStatusChart", {
      type: "doughnut",
      data: {
        labels: order,
        datasets: [{ data: counts, backgroundColor: [COLORS.amber, COLORS.teal, COLORS.coral], borderWidth: 0 }],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        cutout: "68%",
        plugins: {
          legend: { position: "bottom" },
          datalabels: {
            color: "#fff",
            formatter: (v, ctx) => {
              const total = ctx.dataset.data.reduce((a, b) => a + b, 0);
              return total ? `${v}\n${Math.round((100 * v) / total)}%` : v;
            },
          },
        },
      },
    });
  }

  function renderBmiHistChart(children) {
    const vals = children.map((c) => c.bmi).filter((v) => typeof v === "number" && !isNaN(v));
    const buckets = [10, 13, 16, 19, 22, 25, 28, 31];
    const labels = [];
    const counts = [];
    for (let i = 0; i < buckets.length - 1; i++) {
      labels.push(`${buckets[i]}\u2013${buckets[i + 1]}`);
      counts.push(vals.filter((v) => v >= buckets[i] && v < buckets[i + 1]).length);
    }
    upsertChart("bmiHistChart", {
      type: "bar",
      data: {
        labels,
        datasets: [{ label: "Children", data: counts, backgroundColor: COLORS.tealSoft, borderRadius: 4 }],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { display: false },
          datalabels: {
            anchor: "end",
            align: "top",
            formatter: (v) => (v ? v : ""),
          },
        },
        scales: {
          x: { grid: { display: false }, title: { display: true, text: "BMI range" } },
          y: { beginAtZero: true, grid: { color: COLORS.grid }, ticks: { precision: 0 } },
        },
      },
    });
  }

  function renderVisionChart(children) {
    const counts = {};
    children.forEach((c) => {
      const v = c.vision || "Not recorded";
      counts[v] = (counts[v] || 0) + 1;
    });
    upsertChart("visionChart", {
      type: "bar",
      data: {
        labels: Object.keys(counts),
        datasets: [{ data: Object.values(counts), backgroundColor: [COLORS.teal, COLORS.coral, COLORS.grid], borderRadius: 4, maxBarThickness: 46 }],
      },
      options: {
        indexAxis: "y",
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { display: false },
          datalabels: {
            anchor: "end",
            align: "right",
            formatter: (v) => (v ? v : ""),
          },
        },
        scales: {
          x: { beginAtZero: true, grid: { color: COLORS.grid }, ticks: { precision: 0 } },
          y: { grid: { display: false } },
        },
      },
    });
  }

  function renderDentalChart() {
    const findings = state.data.dental.findings || {};
    const labels = Object.keys(findings);
    const values = Object.values(findings);
    upsertChart("dentalChart", {
      type: "bar",
      data: {
        labels,
        datasets: [{ label: "Children flagged", data: values, backgroundColor: COLORS.blue, borderRadius: 4, maxBarThickness: 30 }],
      },
      options: {
        indexAxis: "y",
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { display: false },
          datalabels: {
            anchor: "end",
            align: "right",
            formatter: (v) => (v ? v : ""),
          },
        },
        scales: {
          x: { beginAtZero: true, grid: { color: COLORS.grid }, ticks: { precision: 0 } },
          y: { grid: { display: false } },
        },
      },
    });
  }

  // ---------------------------------------------------------------- table
  function renderTable() {
    let children = getFilteredChildren();
    if (state.search) {
      children = children.filter(
        (c) =>
          (c.name || "").toLowerCase().includes(state.search) ||
          (c.uhid || "").toLowerCase().includes(state.search)
      );
    }

    const totalPages = Math.max(1, Math.ceil(children.length / state.pageSize));
    state.page = Math.min(state.page, totalPages);
    const start = (state.page - 1) * state.pageSize;
    const pageItems = children.slice(start, start + state.pageSize);

    const tbody = document.getElementById("childrenTableBody");
    tbody.innerHTML = pageItems
      .map(
        (c) => `
      <tr>
        <td>${escapeHtml(c.uhid || "")}</td>
        <td>${escapeHtml(c.name || "")}</td>
        <td>${c.age ?? "—"}</td>
        <td>${escapeHtml(c.gender || "—")}</td>
        <td>${typeof c.bmi === "number" ? c.bmi.toFixed(1) : "—"}</td>
        <td>${bmiBadge(c.bmiStatus)}</td>
        <td>${escapeHtml(c.vision || "Not recorded")}</td>
        <td>${c.dentalScreened ? "Yes" : "No"}</td>
      </tr>`
      )
      .join("");

    document.getElementById("tableCount").textContent = `${children.length} children match current filters`;
    document.getElementById("pageIndicator").textContent = `Page ${state.page} of ${totalPages}`;
    document.getElementById("prevPage").disabled = state.page <= 1;
    document.getElementById("nextPage").disabled = state.page >= totalPages;
  }

  function bmiBadge(status) {
    const cls =
      status === "Underweight"
        ? "badge-status--underweight"
        : status === "Normal"
        ? "badge-status--normal"
        : status === "Overweight"
        ? "badge-status--overweight"
        : "badge-status--unknown";
    return `<span class="badge-status ${cls}">${escapeHtml(status || "Unknown")}</span>`;
  }

  function escapeHtml(str) {
    return String(str).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }
})();
