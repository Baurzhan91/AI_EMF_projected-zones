let map;
let mapMarkers = {}; 
let buildingPolygons = {}; 
let antennas = [];
let worker = null;
let calculationResults = null;
const S_LIMIT = 0.1; // 10 мкВт/см2 = 0.1 Вт/м2

let currentPatternH = new Array(360).fill(0);
let currentPatternV = new Array(360).fill(0);

window.onload = () => {
  map = L.map("map-view").setView([51.1282, 71.4304], 17);
  
  L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Street_Map/MapServer/tile/{z}/{y}/{x}', {
    attribution: 'Tiles &copy; Esri &mdash; Source: Esri'
  }).addTo(map);

  map.pm.addControls({ position: "topleft", drawCircle: false, drawMarker: false, drawPolyline: false, drawCircleMarker: false, drawText: false });

  // Глобальный слушатель удаления полигонов (Geoman)
  map.on('pm:remove', (e) => {
    if (buildingPolygons[e.layer._leaflet_id]) {
        delete buildingPolygons[e.layer._leaflet_id];
    }
  });

  // Отслеживание нарисованных вручную зданий
  map.on("pm:create", (e) => {
    let layer = e.layer;
    let b_id = layer._leaflet_id;
    let coords = layer.getLatLngs()[0].map(c => [c.lat, c.lng]);
    buildingPolygons[b_id] = { layer: layer, height: 12, coords: coords };
    
    layer.bindPopup(buildPopupHTML(b_id, 12, 4));
    attachPolygonEditListeners(layer, b_id); // Цепляем слушатели изменения вектора
  });

  map.on("click", (e) => {
    document.getElementById("lat").value = e.latlng.lat.toFixed(6);
    document.getElementById("lon").value = e.latlng.lng.toFixed(6);
  });
};

// Функция для синхронизации векторных изменений с математическим ядром
function attachPolygonEditListeners(layer, b_id) {
    layer.on('pm:edit', (e) => {
        if (buildingPolygons[b_id]) {
            buildingPolygons[b_id].coords = e.target.getLatLngs()[0].map(c => [c.lat, c.lng]);
        }
    });
    layer.on('pm:dragend', (e) => {
        if (buildingPolygons[b_id]) {
            buildingPolygons[b_id].coords = e.target.getLatLngs()[0].map(c => [c.lat, c.lng]);
        }
    });
}

function switchTab(viewId, element) {
  document.querySelectorAll(".view-area").forEach(el => el.classList.remove("active"));
  document.querySelectorAll(".tab").forEach(el => el.classList.remove("active"));
  document.getElementById(viewId).classList.add("active");
  element.classList.add("active");
  
  if (viewId === "map-view") map.invalidateSize();
  if (viewId === "plotly-view") window.dispatchEvent(new Event('resize'));
}

function flyToCoords() {
  let lat = parseFloat(document.getElementById("lat").value) || 51.1282;
  let lon = parseFloat(document.getElementById("lon").value) || 71.4304;
  map.flyTo([lat, lon], 18);
}

function buildPopupHTML(b_id, height, floors) {
  return `
      <div style="font-size:12px;">
          <b>Настройка здания</b><br>
          <label>Высота (м): <input type="number" id="h_${b_id}" value="${height}" style="width:60px;" onchange="updateBld(${b_id})"></label>
      </div>
  `;
}

window.updateBld = function (b_id) {
  let h = parseFloat(document.getElementById(`h_${b_id}`).value);
  if (buildingPolygons[b_id]) buildingPolygons[b_id].height = h;
};

// Загрузка зданий из OSM
async function loadBuildings() {
  let lat = parseFloat(document.getElementById("lat").value);
  let lon = parseFloat(document.getElementById("lon").value);
  let radius = 250;
  let query = `[out:json];(way["building"](around:${radius},${lat},${lon});relation["building"](around:${radius},${lat},${lon}););out body;>;out skel qt;`;

  // Список резервных серверов Overpass API
  const endpoints = [
    "https://overpass-api.de/api/interpreter",
    "https://lz4.overpass-api.de/api/interpreter",
    "https://maps.mail.ru/osm/tools/overpass/api/interpreter" // Резервный шлюз
  ];

  let data = null;
  
  // Перебираем серверы, пока один из них не ответит
  for (let url of endpoints) {
    try {
      // 1. Пробуем безопасный POST-запрос с заголовками
      let res = await fetch(url, { 
          method: "POST", 
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: "data=" + encodeURIComponent(query) 
      });
      
      // 2. Если сервер выдал ошибку CORS/405 для POST, пробуем GET
      if (!res.ok) {
          res = await fetch(url + "?data=" + encodeURIComponent(query));
      }

      if (res.ok) { 
          data = await res.json(); 
          break; // Данные получены, выходим из цикла
      }
    } catch (e) { 
        console.warn(`Фолбек OSM API: Узел ${url} недоступен. Переключаюсь...`); 
    }
  }

  if (!data) return alert("❌ Ошибка соединения с OpenStreetMap. Все серверы отклонили запрос.");

  let nodes = {};
  data.elements.forEach(e => { if (e.type === "node") nodes[e.id] = [e.lat, e.lon]; });

  // Очистка старых слоев
  Object.values(buildingPolygons).forEach(b => map.removeLayer(b.layer));
  buildingPolygons = {};

  // Отрисовка новых полигонов зданий
  data.elements.forEach(e => {
    if (e.type === "way" && e.nodes) {
      let coords = e.nodes.map(n => nodes[n]).filter(c => c);
      if (coords.length > 2) {
        let height = e.tags.height ? parseFloat(e.tags.height) : (e.tags["building:levels"] ? e.tags["building:levels"] * 3 : 12);
        let poly = L.polygon(coords, { color: "#666", weight: 1, fillColor: "#ccc", fillOpacity: 0.5 }).addTo(map);
        
        let b_id = poly._leaflet_id;
        poly.bindPopup(`
            <div style="font-size:12px;">
                <b>Настройка здания</b><br>
                <label>Высота (м): <input type="number" id="h_${b_id}" value="${height}" style="width:60px;" onchange="updateBld(${b_id})"></label>
            </div>
        `);
        buildingPolygons[b_id] = { layer: poly, height: height, coords: coords };
        
        // Синхронизация с 3D ядром при редактировании векторов (если функция подключена)
        if (typeof attachPolygonEditListeners === "function") {
            attachPolygonEditListeners(poly, b_id);
        }
      }
    }
  });
  
  alert(`✅ Загружено зданий: ${Object.keys(buildingPolygons).length}`);
}

function createSectorIcon(color, az) {
  let svg = `<svg width="24" height="24" viewBox="0 0 24 24" style="transform: rotate(${az}deg);"><path d="M12 0 L24 24 L12 18 L0 24 Z" fill="${color}" stroke="black" stroke-width="1"/></svg>`;
  return L.divIcon({ html: svg, className: "", iconSize: [24, 24], iconAnchor: [12, 12] });
}

async function handlePatternUpload(event) {
    let file = event.target.files[0];
    if (!file) return;
    let text = await file.text();
    
    let patH = new Array(360).fill(0);
    let patV = new Array(360).fill(0);
    let mode = null;
    let count = 0;

    text.split('\n').forEach(line => {
        line = line.trim();
        if(line.includes('HORIZONTAL')) { mode = 'H'; count = 0; return; }
        if(line.includes('VERTICAL')) { mode = 'V'; count = 0; return; }
        if(mode && count < 360) {
            let val = parseFloat(line.split(/\s+/).pop());
            if(!isNaN(val)) {
                let att = val <= 0 ? Math.abs(val) : val;
                if(mode === 'H') patH[count] = att;
                if(mode === 'V') patV[count] = att;
                count++;
            }
        }
    });

    currentPatternH = patH;
    currentPatternV = patV;
    document.getElementById('lbl-file').innerText = '✅ ДН Загружена (H+V)';
    document.getElementById('lbl-file').className = 'btn btn-success';
    event.target.value = ''; 
}

function updateTechDefaults() {
  let is5G = document.getElementById("tech").value === "5G";
  document.getElementById("f_tdc").value = is5G ? 74 : 100;
  document.getElementById("f_pr").value = is5G ? 32 : 100;
  if (!is5G) document.getElementById("gainSSB").value = document.getElementById("gainCSI").value;
}

function addAntenna() {
  let tech = document.getElementById("tech").value;
  let is5G = tech === "5G";
  
  let s = {
    id: Date.now(),
    tech: tech,
    power: parseFloat(document.getElementById("power").value) || 0,
    gainCSI: parseFloat(document.getElementById("gainCSI").value) || 0,
    gainSSB: parseFloat(document.getElementById("gainSSB").value) || 0,
    azimuth: parseFloat(document.getElementById("azimuth").value) || 0,
    tilt: parseFloat(document.getElementById("tilt").value) || 0,
    height: parseFloat(document.getElementById("height").value) || 0,
    f_tdc: (parseFloat(document.getElementById("f_tdc").value) || 100) / 100,
    f_pr: (parseFloat(document.getElementById("f_pr").value) || 100) / 100,
    f_ssb: is5G ? 0.15 : 0, 
    lat: parseFloat(document.getElementById("lat").value),
    lon: parseFloat(document.getElementById("lon").value),
    msi_h: [...currentPatternH],
    msi_v: [...currentPatternV]
  };
  antennas.push(s);

  let color = is5G ? "red" : "blue";
  
  // Создаем перетаскиваемый маркер с нашей новой иконкой-стрелкой
  let marker = L.marker([s.lat, s.lon], { 
      draggable: true, 
      icon: createSectorIcon(color, s.azimuth) 
  }).addTo(map);
  
  marker.bindTooltip(`${s.tech} (Аз:${s.azimuth}°)`);

  // Слушатель: когда вы отпускаете маркер после перетаскивания по крыше
  marker.on("dragend", function (e) {
    let pos = e.target.getLatLng(); // Получаем новые координаты на карте
    let sec = antennas.find((a) => a.id === s.id);
    if (sec) { 
        sec.lat = pos.lat; 
        sec.lon = pos.lng; 
    }
    // Автоматически обновляем координаты в левой панели для наглядности
    document.getElementById("lat").value = pos.lat.toFixed(6);
    document.getElementById("lon").value = pos.lng.toFixed(6);
  });

  mapMarkers[s.id] = marker;
  
  renderAntennaList();
  document.getElementById("azimuth").value = (s.azimuth + 120) % 360;
}

function deleteAntenna(id) {
  antennas = antennas.filter(a => a.id !== id);
  if (mapMarkers[id]) { map.removeLayer(mapMarkers[id]); delete mapMarkers[id]; }
  renderAntennaList();
}

function clearAntennas() {
  antennas = [];
  Object.values(mapMarkers).forEach(m => map.removeLayer(m));
  mapMarkers = {};
  renderAntennaList();
}

function renderAntennaList() {
  let list = document.getElementById("sector-list");
  list.innerHTML = "";
  document.getElementById("sector-count").innerText = antennas.length;
  antennas.forEach((a, i) => {
    list.innerHTML += `<div class="sector-item">
      <span>[${i+1}] ${a.tech} | ${a.power}Вт | Аз:${a.azimuth}°</span>
      <button class="btn-danger" style="width:25px; padding:2px; margin:0;" onclick="deleteAntenna(${a.id})">✕</button>
    </div>`;
  });
}

// УЛУЧШЕННЫЙ WEB WORKER (Добавлена физика ближней зоны по IEC 62232)
function calculateBOZ() {
    if (antennas.length === 0) return alert("Добавьте сектора!");
    document.getElementById('loader').style.display = 'flex';
    document.getElementById('progress').style.width = '0%';

    let bldData = Object.values(buildingPolygons).map(b => ({ coords: b.coords, height: b.height }));

    const workerCode = `
        self.onmessage = function(e) {
          try {
            let { sectors, s_limit, centerLat, centerLon } = e.data;
            let points = []; let h_slices = []; let v_slices = [];
            let maxDist = 250; let step = 4;
            let totalSteps = Math.floor((maxDist * 2) / step);
            let currentStep = 0;

            sectors.forEach(sec => {
                sec.lin_h = sec.msi_h.map(v => Math.pow(10, -(v || 0)/10));
                sec.lin_v = sec.msi_v.map(v => Math.pow(10, -(v || 0)/10));
                sec.lin_g_csi = Math.pow(10, (sec.gainCSI || 0)/10);
                sec.lin_g_ssb = Math.pow(10, (sec.gainSSB || 0)/10);
                sec.lx = (sec.lon - centerLon) * 111320 * Math.cos(centerLat * Math.PI / 180);
                sec.ly = (sec.lat - centerLat) * 111320;
            });

            for(let x = -maxDist; x <= maxDist; x += step) {
                for(let y = -maxDist; y <= maxDist; y += step) {
                    for(let z = 0; z <= 80; z += step) {
                        let ppe_sum = 0;
                        for(let sec of sectors) {
                            let dx = x - sec.lx; let dy = y - sec.ly; let dz = z - sec.height;
                            let r_sq = dx*dx + dy*dy + dz*dz;
                            if(r_sq < 0.1) continue; // Защита от деления на ноль
                            
                            // IEC 62232: Near-field correction (Rayleigh Distance Smoothing)
                            // Запрещаем математическое схлопывание площади волны в точку
                            // Принимаем эффективную длину антенны ~1.5м
                            let r_eff_sq = r_sq + (1.5 * 1.5); 
                            
                            let mapAz = (90 - (Math.atan2(dy, dx) * 180 / Math.PI) + 360) % 360;
                            let diffAz = Math.round(Math.abs(mapAz - sec.azimuth)) % 360;
                            
                            let elAng = Math.atan2(-dz, Math.sqrt(dx*dx + dy*dy)) * 180 / Math.PI;
                            let diffEl = Math.round(elAng - (sec.tilt || 0));
                            diffEl = ((diffEl % 360) + 360) % 360;

                            let fH = sec.lin_h[diffAz];
                            let fV = sec.lin_v[diffEl];
                            
                            let p_base = sec.power * sec.f_tdc;
                            let eirp_traf = p_base * (1 - sec.f_ssb) * sec.f_pr * sec.lin_g_csi * fH * fV;
                            let eirp_ssb = p_base * sec.f_ssb * sec.lin_g_ssb * fH * fV;
                            
                            // Используем сглаженный квадрат расстояния (r_eff_sq)
                            ppe_sum += ((eirp_traf + eirp_ssb) * 1.69) / (12.566 * r_eff_sq);
                        }
                        if((ppe_sum / s_limit) >= 1.0) points.push({x, y, z, val: ppe_sum});
                    }
                }
                currentStep++;
                if(currentStep % 5 === 0) self.postMessage({ progress: (currentStep / totalSteps) * 50 });
            }

            sectors.forEach((sec, i) => {
                let h_dat = []; let v_dat = [];
                let p_base = sec.power * sec.f_tdc;
                let tiltIdx = ((360 - (sec.tilt || 0)) % 360 + 360) % 360;
                let base_att_v = sec.lin_v[tiltIdx];

                for(let d = 1; d <= maxDist; d += 2) {
                    let r_eff_sq = (d * d) + (1.5 * 1.5); // Near-field correction для графика
                    
                    let eirp_traf_h = p_base * (1 - sec.f_ssb) * sec.f_pr * sec.lin_g_csi * base_att_v;
                    let eirp_ssb_h = p_base * sec.f_ssb * sec.lin_g_ssb * base_att_v;
                    let s_horiz = ((eirp_traf_h + eirp_ssb_h) * 1.69 / (12.566 * r_eff_sq)) * 100;
                    h_dat.push({d: d, ppe: s_horiz});

                    if(d === 50) {
                        for(let z = 0; z <= 80; z += 1) {
                            let dz = z - sec.height;
                            let r_eff_sq_v = (50 * 50) + (dz * dz) + (1.5 * 1.5);
                            
                            let elAng = Math.atan2(-dz, 50) * 180 / Math.PI;
                            let diffEl = Math.round(elAng - (sec.tilt || 0));
                            diffEl = ((diffEl % 360) + 360) % 360; 

                            let fV = sec.lin_v[diffEl];
                            let eirp_traf_v = p_base * (1 - sec.f_ssb) * sec.f_pr * sec.lin_g_csi * fV;
                            let eirp_ssb_v = p_base * sec.f_ssb * sec.lin_g_ssb * fV;
                            let s_vert = ((eirp_traf_v + eirp_ssb_v) * 1.69 / (12.566 * r_eff_sq_v)) * 100;
                            v_dat.push({z: z, ppe: s_vert});
                        }
                    }
                }
                h_slices.push({id: sec.id, tech: sec.tech, data: h_dat});
                v_slices.push({id: sec.id, tech: sec.tech, data: v_dat});
                
                self.postMessage({ progress: 50 + ((i + 1) / sectors.length) * 50 });
            });

            self.postMessage({ done: true, points: points, h_slices: h_slices, v_slices: v_slices });
          } catch(err) {
            self.postMessage({ error: err.message });
          }
        };
    `;

    let blob = new Blob([workerCode], { type: "application/javascript" });
    worker = new Worker(URL.createObjectURL(blob));

    let centerLat = parseFloat(document.getElementById("lat").value) || 51.1282;
    let centerLon = parseFloat(document.getElementById("lon").value) || 71.4304;
    
    worker.postMessage({ sectors: antennas, s_limit: S_LIMIT, centerLat: centerLat, centerLon: centerLon });

    worker.onmessage = function (e) {
        if (e.data.error) {
            alert("❌ Ошибка в расчетах 3D: " + e.data.error);
            document.getElementById("loader").style.display = "none";
            worker.terminate();
        } else if (e.data.progress) {
            document.getElementById("progress").style.width = e.data.progress + "%";
        } else if (e.data.done) {
            calculationResults = e.data;
            document.getElementById("loader").style.display = "none";
            switchTab("plotly-view", document.querySelectorAll(".tab")[1]);
            
            setTimeout(() => {
                render3D(e.data.points, bldData, centerLat, centerLon);
                generateReports(e.data.h_slices, e.data.v_slices);
            }, 100);
            worker.terminate();
        }
    };
}

function abortCalculation() {
  if (worker) worker.terminate();
  document.getElementById("loader").style.display = "none";
}

function render3D(points, bldData, centerLat, centerLon) {
  let traces = [{
    x: points.map(p => p.x), y: points.map(p => p.y), z: points.map(p => p.z),
    mode: "markers", marker: { size: 4, color: points.map(p => p.val), colorscale: "Jet", opacity: 0.5 },
    type: "scatter3d", name: "БОЗ"
  }];

  let bX = [], bY = [], bZ = [];
  bldData.forEach(b => {
    let lc = b.coords.map(c => [ (c[1]-centerLon)*111320*Math.cos(centerLat*Math.PI/180), (c[0]-centerLat)*111320 ]);
    lc.forEach(c => { bX.push(c[0]); bY.push(c[1]); bZ.push(0); }); bX.push(null, null, null);
    lc.forEach(c => { bX.push(c[0]); bY.push(c[1]); bZ.push(b.height); }); bX.push(null, null, null);
    lc.forEach(c => { bX.push(c[0], c[0], null); bY.push(c[1], c[1], null); bZ.push(0, b.height, null); });
  });

  if (bX.length > 0) traces.push({ x: bX, y: bY, z: bZ, mode: "lines", type: "scatter3d", line: { color: "#888", width: 2 }, name: "Здания" });

  Plotly.newPlot("plotly-view", traces, { title: "3D Модель ЭМП", scene: { xaxis: {range: [-250, 250]}, yaxis: {range: [-250, 250]}, zaxis: {range: [0, 80]} }, margin: { l: 0, r: 0, b: 0, t: 40 } });
}

function generateReports(h_slices, v_slices) {
  let html = ``;
  h_slices.forEach((slice, i) => {
    html += `<div style="margin-bottom:20px;"><h4>Сектор ${i + 1} (${slice.tech})</h4>
             <div style="display:flex; gap:10px;">
               <div id="ch_h_${i}" style="flex:1; height:300px; border:1px solid #ccc;"></div>
               <div id="ch_v_${i}" style="flex:1; height:300px; border:1px solid #ccc;"></div>
             </div></div>`;
  });
  document.getElementById("report-content").innerHTML = html;

  h_slices.forEach((slice, i) => {
    Plotly.newPlot(`ch_h_${i}`, [
      { x: slice.data.map(d => d.d), y: slice.data.map(d => d.ppe), mode: "lines", name: "ППЭ (Гор)" },
      { x: [0, 250], y: [S_LIMIT, S_LIMIT], mode: "lines", line: { color: "red", dash: "dash" }, name: "ПДУ" }
    ], { title: "Срез H", margin: { l: 40, r: 20, t: 30, b: 30 } });

    Plotly.newPlot(`ch_v_${i}`, [
      { x: v_slices[i].data.map(d => d.z), y: v_slices[i].data.map(d => d.ppe), mode: "lines", name: "ППЭ (Верт)" },
      { x: [0, 80], y: [S_LIMIT, S_LIMIT], mode: "lines", line: { color: "red", dash: "dash" }, name: "ПДУ" }
    ], { title: "Срез V (50м)", margin: { l: 40, r: 20, t: 30, b: 30 } });
  });
}

function exportExcel() {
  if (!calculationResults || typeof XLSX === 'undefined') return alert("❌ Сначала выполните расчет!");
  let wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(antennas), "Оборудование");
  let exportData = calculationResults.h_slices[0].data.map(d => ({ "Дистанция (м)": d.d, "ППЭ (мкВт/см2)": d.ppe.toFixed(4) }));
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(exportData), "Расчет ППЭ");
  XLSX.writeFile(wb, `EMF_Report.xlsx`);
}