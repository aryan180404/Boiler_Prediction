(function () {
  const D = window.BOILER_DATA;
  const el = (id) => document.getElementById(id);
  const plant = el("plant");
  const results = el("results");
  const inputs = el("inputs");
  const powerBtn = el("power");
  const powerLabel = el("power-label");
  const liveVal = el("live-val");
  const SVG = "http://www.w3.org/2000/svg";
  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)");

  const fmt = (n, d = 2) =>
    Number(n).toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d }).replace("-", "−");
  const nSensor = D.n_sensor_inputs;
  const targetIdx = D.features.indexOf(D.target);
  const lagSeconds = (name) => Number(name.match(/lag(\d+)/)[1]) * D.seconds_per_step;

  // outlet temperature history, oldest first: [feature index, seconds before now]
  const history = D.features
    .map((name, i) => (i >= nSensor ? [i, lagSeconds(name)] : null))
    .filter(Boolean)
    .concat([[targetIdx, 0]])
    .sort((a, b) => b[1] - a[1]);

  // each sensor input lands in the first group whose test matches its name
  const GROUPS = [
    { title: "Pressure", test: (n) => /pressure/i.test(n) && !/differential/i.test(n) },
    { title: "Differential pressure", test: (n) => /differential/i.test(n) },
    { title: "Steam and desuperheating", test: (n) => /desuperheat|steam flow/i.test(n) },
    { title: "Flue gas and air temperature", test: (n) => /temperature/i.test(n) },
    { title: "Air, fans and oxygen", test: () => true },
  ];

  // a wide underlay behind every animated stream so it reads as a pipe
  const pipes = plant.querySelector(".pipes");
  plant.querySelectorAll(".flow path").forEach((p) => pipes.appendChild(p.cloneNode()));

  let current = -1;
  let shown = null;
  let tempAnim = null;
  let pending = null;
  let running = false;

  function pickRow() {
    let i;
    do { i = Math.floor(Math.random() * D.rows.length); } while (i === current && D.rows.length > 1);
    current = i;
    return D.rows[i];
  }

  function countTo(target) {
    if (tempAnim) cancelAnimationFrame(tempAnim);
    if (reduceMotion.matches) { liveVal.textContent = fmt(target, 1); return; }
    const from = parseFloat(liveVal.textContent.replace("−", "-").replace(/,/g, "")) || target - 6;
    const t0 = performance.now(), dur = 1100;
    const step = (t) => {
      const k = Math.min(1, (t - t0) / dur);
      const e = 1 - Math.pow(1 - k, 3);
      liveVal.textContent = fmt(from + (target - from) * e, 1);
      if (k < 1) tempAnim = requestAnimationFrame(step);
    };
    tempAnim = requestAnimationFrame(step);
  }

  function renderFigures(row) {
    const err = row.predicted - row.actual;
    const within = Math.abs(err) <= D.metrics.mae;
    el("row-id").textContent = row.row.toLocaleString("en-US");
    el("row-note").textContent = `One of ${D.test_rows.toLocaleString("en-US")} held-out rows the model never trained on, picked at random.`;
    el("predicted").textContent = fmt(row.predicted);
    el("actual").textContent = fmt(row.actual);
    el("error").textContent = (err >= 0 ? "+" : "−") + fmt(Math.abs(err), 3);
    const status = el("status");
    status.className = "status " + (within ? "is-good" : "is-warn");
    el("status-text").textContent = within
      ? `Within the model's mean error of ${fmt(D.metrics.mae, 3)} °C.`
      : `Larger than the model's mean error of ${fmt(D.metrics.mae, 3)} °C.`;
    el("band-label").textContent = `Mean error, ±${fmt(D.metrics.mae, 3)} °C`;
  }

  function renderInputs(row) {
    const wrap = el("input-groups");
    wrap.innerHTML = "";
    const sections = [{
      title: "Outlet steam temperature",
      rows: history.slice().reverse().map(([i, s]) => [s === 0 ? "Now" : `${s} s earlier`, row.inputs[i]]),
    }];
    const buckets = GROUPS.map((g) => ({ title: g.title, rows: [] }));
    D.features.slice(0, nSensor).forEach((name, i) => {
      if (i === targetIdx) return;
      buckets[GROUPS.findIndex((g) => g.test(name))].rows.push([name, row.inputs[i]]);
    });
    // most relevant to the steam first
    [2, 3, 4, 0, 1].forEach((k) => sections.push(buckets[k]));

    sections.forEach((sec) => {
      const div = document.createElement("div");
      div.className = "group";
      const h = document.createElement("h3");
      h.textContent = sec.title;
      const table = document.createElement("table");
      const body = document.createElement("tbody");
      sec.rows.forEach(([label, v]) => {
        const tr = document.createElement("tr");
        const a = document.createElement("td");
        const b = document.createElement("td");
        a.textContent = label;
        b.className = "v";
        b.textContent = fmt(v, 2);
        tr.append(a, b);
        body.appendChild(tr);
      });
      table.appendChild(body);
      div.append(h, table);
      wrap.appendChild(div);
    });

    el("footnote").textContent =
      `Over all ${D.test_rows.toLocaleString("en-US")} test rows the model's mean absolute error is ` +
      `${fmt(D.metrics.mae, 3)} °C, root mean squared error ${fmt(D.metrics.rmse, 3)} °C and R² ${fmt(D.metrics.r2, 4)}. ` +
      `Trained on the first ${D.train_rows.toLocaleString("en-US")} rows; forecast horizon ${D.horizon_steps} rows × ${D.seconds_per_step} s = one minute.`;
  }

  // --- chart: last minute of outlet temperature, then the forecast ---------
  function node(tag, attrs, parent) {
    const n = document.createElementNS(SVG, tag);
    for (const k in attrs) n.setAttribute(k, attrs[k]);
    if (parent) parent.appendChild(n);
    return n;
  }

  function niceStep(span) {
    const steps = [0.1, 0.2, 0.25, 0.5, 1, 2, 2.5, 5, 10];
    return steps.find((s) => span / s <= 6) || 10;
  }

  function drawChart(row) {
    const box = el("chart");
    box.innerHTML = "";
    const W = Math.max(300, box.clientWidth);
    const narrow = W < 520;
    const H = narrow ? 240 : 290;
    const m = { t: 26, r: narrow ? 104 : 140, b: 32, l: 46 };
    const pw = W - m.l - m.r, ph = H - m.t - m.b;
    const mae = D.metrics.mae;

    const pts = history.map(([i, s]) => [-s, row.inputs[i]]);
    const now = pts[pts.length - 1];
    const ys = pts.map((p) => p[1]).concat([row.actual, row.predicted - mae, row.predicted + mae]);
    let lo = Math.min(...ys), hi = Math.max(...ys);
    const span = Math.max(hi - lo, 0.6);
    lo -= span * 0.14; hi += span * 0.14;
    const step = niceStep(hi - lo);
    const dec = step >= 1 ? 0 : step === 0.25 ? 2 : 1;

    const sx = (t) => m.l + ((t + 60) / 120) * pw;
    const sy = (v) => m.t + (1 - (v - lo) / (hi - lo)) * ph;

    const svg = node("svg", { width: W, height: H, viewBox: `0 0 ${W} ${H}`, role: "img",
      "aria-label": `Outlet temperature went from ${fmt(pts[0][1])} to ${fmt(now[1])} °C over the last minute. Forecast ${fmt(row.predicted)} °C, actual ${fmt(row.actual)} °C.` });

    node("rect", { x: sx(0), y: m.t, width: sx(60) - sx(0), height: ph, fill: "var(--zone)" }, svg);
    node("text", { x: sx(-60) + 2, y: m.t - 10, class: "zone-lbl" }, svg).textContent = "Last minute";
    node("text", { x: sx(0) + 8, y: m.t - 10, class: "zone-lbl" }, svg).textContent = "Next minute";

    for (let v = Math.ceil(lo / step) * step; v <= hi; v += step) {
      const y = sy(v);
      node("line", { x1: m.l, x2: m.l + pw, y1: y, y2: y, stroke: "var(--grid)" }, svg);
      const t = node("text", { x: m.l - 8, y: y + 4, "text-anchor": "end", class: "tick" }, svg);
      t.textContent = fmt(v, dec);
    }
    node("line", { x1: m.l, x2: m.l + pw, y1: m.t + ph, y2: m.t + ph, stroke: "var(--line)" }, svg);
    node("line", { x1: sx(0), x2: sx(0), y1: m.t, y2: m.t + ph, stroke: "var(--steel)", "stroke-width": 1 }, svg);
    [[-60, "−60 s"], [-30, "−30 s"], [0, "Now"], [30, "+30 s"], [60, "+60 s"]].forEach(([t, s]) => {
      const x = node("text", { x: sx(t), y: H - 10, "text-anchor": "middle", class: "tick" }, svg);
      x.textContent = s;
    });

    // ± mean error band around the forecast
    node("rect", { x: sx(60) - 7, width: 14, y: sy(row.predicted + mae), height: sy(row.predicted - mae) - sy(row.predicted + mae),
      rx: 4, fill: "var(--ink)", "fill-opacity": 0.1 }, svg);
    node("line", { x1: sx(0), y1: sy(now[1]), x2: sx(60), y2: sy(row.predicted), stroke: "var(--ink-2)",
      "stroke-width": 1.5, "stroke-dasharray": "4 4" }, svg);
    node("path", { d: pts.map((p, k) => (k ? "L" : "M") + sx(p[0]) + " " + sy(p[1])).join(" "), fill: "none",
      stroke: "var(--steam)", "stroke-width": 2, "stroke-linejoin": "round", "stroke-linecap": "round" }, svg);
    pts.forEach((p) => node("circle", { cx: sx(p[0]), cy: sy(p[1]), r: 4, fill: "var(--steam)", stroke: "#fff", "stroke-width": 2 }, svg));
    node("circle", { cx: sx(60), cy: sy(row.actual), r: 5, fill: "var(--steam)", stroke: "#fff", "stroke-width": 2 }, svg);
    node("circle", { cx: sx(60), cy: sy(row.predicted), r: 5, fill: "#fff", stroke: "var(--ink)", "stroke-width": 2 }, svg);

    // end labels: higher value on top, spread apart with leaders when they collide
    const ends = [
      { name: "Actual", v: row.actual, y: sy(row.actual) },
      { name: "Predicted", v: row.predicted, y: sy(row.predicted) },
    ].sort((a, b) => a.y - b.y);
    const gap = 34;
    if (ends[1].y - ends[0].y < gap) {
      const mid = (ends[0].y + ends[1].y) / 2;
      ends[0].ly = mid - gap / 2; ends[1].ly = mid + gap / 2;
    } else { ends[0].ly = ends[0].y; ends[1].ly = ends[1].y; }
    const lx = sx(60) + 18;
    ends.forEach((e) => {
      if (Math.abs(e.ly - e.y) > 1) {
        node("path", { d: `M${sx(60) + 8} ${e.y} L${lx - 4} ${e.ly}`, stroke: "var(--steel)", fill: "none" }, svg);
      }
      node("text", { x: lx, y: e.ly - 3, class: "end-name" }, svg).textContent = e.name;
      node("text", { x: lx, y: e.ly + 13, class: "end-val" }, svg).textContent = `${fmt(e.v)} °C`;
    });

    // hover and keyboard targets bigger than the marks
    const tip = document.createElement("div");
    tip.className = "tip";
    const targets = pts.map((p) => [p[0], p[1], p[0] === 0 ? "Now" : `${-p[0]} s earlier`])
      .concat([[60, row.actual, "Actual, one minute later"], [60, row.predicted, "Predicted"]]);
    targets.forEach(([t, v, label]) => {
      const h = node("circle", { cx: sx(t), cy: sy(v), r: 11, class: "hit", tabindex: 0, "aria-label": `${label}: ${fmt(v)} °C` }, svg);
      const on = () => {
        tip.innerHTML = `${label}<br><b>${fmt(v)} °C</b>`;
        tip.style.left = sx(t) + "px";
        tip.style.top = sy(v) + "px";
        tip.classList.add("on");
      };
      const off = () => tip.classList.remove("on");
      h.addEventListener("pointerenter", on);
      h.addEventListener("pointerleave", off);
      h.addEventListener("focus", on);
      h.addEventListener("blur", off);
    });

    box.append(svg, tip);
  }

  function show(row) {
    shown = row;
    const first = results.hidden;
    results.hidden = false;
    inputs.hidden = false;
    if (first) {
      results.classList.add("enter");
    } else {
      const body = el("results-body");
      body.classList.remove("swap");
      void body.offsetWidth; // restart the crossfade
      body.classList.add("swap");
    }
    renderFigures(row);
    drawChart(row);
    renderInputs(row);
    countTo(row.predicted);
  }

  function setRunning(on) {
    running = on;
    plant.classList.toggle("running", on);
    powerBtn.setAttribute("aria-pressed", String(on));
    powerLabel.textContent = on ? "Stop the boiler" : "Start the boiler";
  }

  powerBtn.addEventListener("click", () => {
    clearTimeout(pending);
    setRunning(!running);
    if (!running) return;
    const first = results.hidden;
    // let the fire catch and the steam line warm up before the numbers arrive
    pending = setTimeout(() => {
      show(pickRow());
      if (first) results.scrollIntoView({ behavior: reduceMotion.matches ? "auto" : "smooth", block: "start" });
    }, first ? 1400 : 500);
  });

  el("another").addEventListener("click", () => show(pickRow()));

  let resizeTimer = null;
  new ResizeObserver(() => {
    if (!shown) return;
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => drawChart(shown), 80);
  }).observe(el("chart"));
})();
