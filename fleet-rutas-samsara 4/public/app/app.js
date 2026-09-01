const tabsEl = document.getElementById('tabs');
const contenidoEl = document.getElementById('contenido');
const fechaInput = document.getElementById('fecha-input');
const btnSync = document.getElementById('btn-sync');
const syncStatus = document.getElementById('sync-status');
const btnLogout = document.getElementById('btn-logout');

const TAB_PATIO = '__patio__';

let rutasData = {};
let rutaActiva = null;
let patioData = { activos: [], historial: [] };
let patioCargado = false;
let patioBusqueda = '';
let patioConfirmando = null;

function hoyISO() {
  const d = new Date();
  const off = d.getTimezoneOffset();
  const local = new Date(d.getTime() - off * 60000);
  return local.toISOString().slice(0, 10);
}

fechaInput.value = hoyISO();

function siSesionExpiro(res) {
  if (res.status === 401) {
    window.location.href = '/login';
    return true;
  }
  return false;
}

async function cargarRutas() {
  if (rutaActiva === TAB_PATIO) {
    // No perdemos la pestaña de patio activa por un cambio de fecha.
    dibujarTabs();
    return;
  }
  contenidoEl.innerHTML = '<p>Cargando...</p>';
  const res = await fetch(`/api/rutas?fecha=${fechaInput.value}`);
  if (siSesionExpiro(res)) return;
  const data = await res.json();
  rutasData = data.rutas;
  if (!rutaActiva || !rutasData[rutaActiva]) {
    rutaActiva = Object.keys(rutasData)[0] || null;
  }
  dibujarTabs();
  dibujarContenido();
}

function dibujarTabs() {
  tabsEl.innerHTML = '';
  Object.keys(rutasData).forEach((ruta) => {
    const btn = document.createElement('button');
    btn.textContent = ruta;
    if (ruta === rutaActiva) btn.classList.add('activa');
    btn.onclick = () => {
      rutaActiva = ruta;
      dibujarTabs();
      dibujarContenido();
    };
    tabsEl.appendChild(btn);
  });

  const btnPatio = document.createElement('button');
  btnPatio.textContent = 'Control de Patio';
  btnPatio.className = 'tab-patio';
  if (rutaActiva === TAB_PATIO) btnPatio.classList.add('activa');
  btnPatio.onclick = async () => {
    rutaActiva = TAB_PATIO;
    dibujarTabs();
    contenidoEl.innerHTML = '<p>Cargando...</p>';
    await cargarPatio();
    dibujarContenido();
  };
  tabsEl.appendChild(btnPatio);
}

function celdaRegistro(asignacion, tipo) {
  const registro = asignacion[tipo];
  const wrap = document.createElement('div');

  if (registro) {
    const fuenteClase = registro.fuente === 'samsara' ? 'fuente-samsara' : 'fuente-manual';
    const linea = document.createElement('div');
    linea.className = `hora-actual ${fuenteClase}`;
    linea.textContent = `${registro.hora.slice(0, 5)} (${registro.fuente})`;
    wrap.appendChild(linea);

    if (registro.detalle) {
      const det = document.createElement('span');
      det.className = 'detalle-gps';
      det.textContent = registro.detalle;
      wrap.appendChild(det);
    }

    const btnBorrar = document.createElement('button');
    btnBorrar.textContent = 'Borrar';
    btnBorrar.className = 'btn-borrar';
    btnBorrar.onclick = async () => {
      await fetch(`/api/registros/${registro.id}`, { method: 'DELETE' });
      cargarRutas();
    };
    wrap.appendChild(btnBorrar);
  } else {
    const sinReg = document.createElement('div');
    sinReg.className = 'sin-registro';
    sinReg.textContent = 'Sin registro';
    wrap.appendChild(sinReg);
  }

  const captura = document.createElement('div');
  captura.className = 'captura';

  const inputHora = document.createElement('input');
  inputHora.type = 'time';

  const btnManual = document.createElement('button');
  btnManual.textContent = 'Manual';
  btnManual.className = 'btn-manual';
  btnManual.onclick = async () => {
    if (!inputHora.value) {
      alert('Escribe una hora primero.');
      return;
    }
    await guardarRegistro(asignacion.id, tipo, 'manual', inputHora.value);
  };

  const btnSamsara = document.createElement('button');
  btnSamsara.textContent = 'Traer de Samsara';
  btnSamsara.className = 'btn-samsara';
  btnSamsara.onclick = async () => {
    btnSamsara.disabled = true;
    btnSamsara.textContent = 'Consultando...';
    try {
      await guardarRegistro(asignacion.id, tipo, 'samsara');
    } finally {
      btnSamsara.disabled = false;
      btnSamsara.textContent = 'Traer de Samsara';
    }
  };

  captura.appendChild(inputHora);
  captura.appendChild(btnManual);
  captura.appendChild(btnSamsara);
  wrap.appendChild(captura);

  return wrap;
}

async function guardarRegistro(asignacion_id, tipo, fuente, hora) {
  const body = { asignacion_id, tipo, fuente, fecha: fechaInput.value };
  if (hora) body.hora = hora;

  const res = await fetch('/api/registros', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (siSesionExpiro(res)) return;

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    alert(`Error: ${err.error || res.statusText}`);
    return;
  }
  cargarRutas();
}

function dibujarContenido() {
  contenidoEl.innerHTML = '';

  if (rutaActiva === TAB_PATIO) {
    dibujarPatio();
    return;
  }

  if (!rutaActiva) {
    contenidoEl.innerHTML = '<p>No hay rutas cargadas.</p>';
    return;
  }

  const bloque = document.createElement('div');
  bloque.className = 'ruta-bloque';

  const turnos = rutasData[rutaActiva];
  turnos.forEach((turno) => {
    const titulo = document.createElement('div');
    titulo.className = 'turno-titulo';
    titulo.textContent = `${turno.ruta} - ${turno.tipo} ${turno.hora_programada.slice(0, 5)}`;
    bloque.appendChild(titulo);

    const tabla = document.createElement('table');
    tabla.innerHTML = `
      <thead>
        <tr>
          <th>Unidad</th>
          <th>Parada</th>
          <th>Llegada</th>
          <th>Inicio</th>
        </tr>
      </thead>
    `;
    const tbody = document.createElement('tbody');

    turno.asignaciones.forEach((asig) => {
      const tr = document.createElement('tr');

      const tdUnidad = document.createElement('td');
      tdUnidad.className = 'unidad';
      tdUnidad.textContent = asig.unidad;

      const tdParada = document.createElement('td');
      tdParada.textContent = asig.parada;

      const tdLlegada = document.createElement('td');
      tdLlegada.appendChild(celdaRegistro(asig, 'llegada'));

      const tdInicio = document.createElement('td');
      tdInicio.appendChild(celdaRegistro(asig, 'inicio'));

      tr.appendChild(tdUnidad);
      tr.appendChild(tdParada);
      tr.appendChild(tdLlegada);
      tr.appendChild(tdInicio);
      tbody.appendChild(tr);
    });

    tabla.appendChild(tbody);
    bloque.appendChild(tabla);
  });

  contenidoEl.appendChild(bloque);
}

// ================== CONTROL DE PATIO ==================

async function cargarPatio() {
  const res = await fetch('/api/patio');
  if (siSesionExpiro(res)) return;
  if (!res.ok) {
    contenidoEl.innerHTML = '<p>Error al cargar el control de patio.</p>';
    return;
  }
  patioData = await res.json();
  patioCargado = true;
}

function horaCorta(iso) {
  return new Date(iso).toLocaleTimeString('es-MX', { hour: '2-digit', minute: '2-digit', hour12: false });
}

function fechaCorta(iso) {
  return new Date(iso).toLocaleDateString('es-MX', { day: '2-digit', month: '2-digit' });
}

function duracionPatio(entradaIso, salidaIso) {
  const inicio = new Date(entradaIso).getTime();
  const fin = salidaIso ? new Date(salidaIso).getTime() : Date.now();
  const mins = Math.max(0, Math.round((fin - inicio) / 60000));
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return h > 0 ? `${h}h ${String(m).padStart(2, '0')}m` : `${m}m`;
}

function dibujarPatio() {
  contenidoEl.innerHTML = '';

  const cont = document.createElement('div');
  cont.className = 'patio-bloque';

  // --- Resumen ---
  const resumen = document.createElement('div');
  resumen.className = 'patio-resumen';
  resumen.innerHTML = `
    <span class="patio-chip">En patio: <strong>${patioData.activos.length}</strong></span>
    <span class="patio-chip">Historial mostrado: <strong>${patioData.historial.length}</strong></span>
  `;
  cont.appendChild(resumen);

  // --- Formulario de entrada ---
  const form = document.createElement('form');
  form.className = 'patio-form';
  form.innerHTML = `
    <div class="patio-form-grid">
      <label>Placa
        <input type="text" name="placa" maxlength="12" required autocomplete="off" />
      </label>
      <label>Conductor
        <input type="text" name="conductor" required autocomplete="off" />
      </label>
      <label>Empresa
        <input type="text" name="empresa" required autocomplete="off" />
      </label>
      <label>Andén
        <input type="text" name="anden" placeholder="Ej. A1" autocomplete="off" />
      </label>
      <label>Operación
        <select name="tipo">
          <option value="carga">Carga</option>
          <option value="descarga">Descarga</option>
        </select>
      </label>
      <label>Observaciones
        <input type="text" name="notas" autocomplete="off" />
      </label>
    </div>
    <div class="patio-form-error" style="display:none;"></div>
    <button type="submit" class="primario">Registrar entrada</button>
  `;

  const errorBox = form.querySelector('.patio-form-error');

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    errorBox.style.display = 'none';
    const fd = new FormData(form);
    const body = {
      placa: fd.get('placa').trim().toUpperCase(),
      conductor: fd.get('conductor').trim(),
      empresa: fd.get('empresa').trim(),
      anden: fd.get('anden').trim(),
      tipo: fd.get('tipo'),
      notas: fd.get('notas').trim(),
    };

    if (!body.placa || !body.conductor || !body.empresa) {
      errorBox.textContent = 'Placa, conductor y empresa son obligatorios.';
      errorBox.style.display = 'block';
      return;
    }

    const submitBtn = form.querySelector('button[type="submit"]');
    submitBtn.disabled = true;

    try {
      const res = await fetch('/api/patio', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (siSesionExpiro(res)) return;
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Error desconocido');
      form.reset();
      await cargarPatio();
      dibujarContenido();
    } catch (err) {
      errorBox.textContent = err.message;
      errorBox.style.display = 'block';
    } finally {
      submitBtn.disabled = false;
    }
  });

  cont.appendChild(form);

  // --- Vehículos activos ---
  const tituloActivos = document.createElement('div');
  tituloActivos.className = 'turno-titulo';
  tituloActivos.textContent = `Vehículos en patio (${patioData.activos.length})`;
  cont.appendChild(tituloActivos);

  if (patioData.activos.length === 0) {
    const vacio = document.createElement('p');
    vacio.className = 'sin-registro';
    vacio.textContent = 'No hay vehículos en el patio en este momento.';
    cont.appendChild(vacio);
  } else {
    const tablaActivos = document.createElement('table');
    tablaActivos.innerHTML = `
      <thead>
        <tr>
          <th>Placa</th><th>Conductor</th><th>Empresa</th><th>Andén</th>
          <th>Operación</th><th>Entrada</th><th>Tiempo en patio</th><th></th>
        </tr>
      </thead>
    `;
    const tbody = document.createElement('tbody');

    patioData.activos.forEach((r) => {
      const tr = document.createElement('tr');

      const tdPlaca = document.createElement('td');
      tdPlaca.className = 'unidad';
      tdPlaca.textContent = r.placa;

      const tdConductor = document.createElement('td');
      tdConductor.textContent = r.conductor;

      const tdEmpresa = document.createElement('td');
      tdEmpresa.textContent = r.empresa;

      const tdAnden = document.createElement('td');
      tdAnden.textContent = r.anden || '-';

      const tdTipo = document.createElement('td');
      tdTipo.textContent = r.tipo === 'carga' ? 'Carga' : 'Descarga';

      const tdEntrada = document.createElement('td');
      tdEntrada.textContent = horaCorta(r.entrada_en);

      const tdDuracion = document.createElement('td');
      tdDuracion.textContent = duracionPatio(r.entrada_en, null);

      const tdAccion = document.createElement('td');
      if (patioConfirmando === r.id) {
        const span = document.createElement('span');
        span.textContent = '¿Confirmar? ';
        const btnSi = document.createElement('button');
        btnSi.textContent = 'Sí';
        btnSi.className = 'btn-manual';
        btnSi.onclick = () => registrarSalidaPatio(r.id);
        const btnNo = document.createElement('button');
        btnNo.textContent = 'No';
        btnNo.onclick = () => {
          patioConfirmando = null;
          dibujarContenido();
        };
        tdAccion.appendChild(span);
        tdAccion.appendChild(btnSi);
        tdAccion.appendChild(btnNo);
      } else {
        const btnSalida = document.createElement('button');
        btnSalida.textContent = 'Registrar salida';
        btnSalida.className = 'btn-borrar';
        btnSalida.onclick = () => {
          patioConfirmando = r.id;
          dibujarContenido();
        };
        tdAccion.appendChild(btnSalida);
      }

      tr.appendChild(tdPlaca);
      tr.appendChild(tdConductor);
      tr.appendChild(tdEmpresa);
      tr.appendChild(tdAnden);
      tr.appendChild(tdTipo);
      tr.appendChild(tdEntrada);
      tr.appendChild(tdDuracion);
      tr.appendChild(tdAccion);
      tbody.appendChild(tr);
    });

    tablaActivos.appendChild(tbody);
    cont.appendChild(tablaActivos);
  }

  // --- Historial ---
  const detalleHistorial = document.createElement('details');
  detalleHistorial.className = 'patio-historial';
  detalleHistorial.open = patioBusqueda.length > 0;

  const resumenHistorial = document.createElement('summary');
  resumenHistorial.textContent = `Historial (${patioData.historial.length})`;
  detalleHistorial.appendChild(resumenHistorial);

  const buscador = document.createElement('input');
  buscador.type = 'text';
  buscador.placeholder = 'Buscar por placa, conductor o empresa';
  buscador.className = 'patio-buscador';
  buscador.value = patioBusqueda;
  buscador.oninput = (e) => {
    patioBusqueda = e.target.value;
    dibujarContenido();
  };
  detalleHistorial.appendChild(buscador);

  const q = patioBusqueda.trim().toLowerCase();
  const historialFiltrado = q
    ? patioData.historial.filter(
        (r) =>
          r.placa.toLowerCase().includes(q) ||
          r.conductor.toLowerCase().includes(q) ||
          r.empresa.toLowerCase().includes(q)
      )
    : patioData.historial;

  if (historialFiltrado.length === 0) {
    const vacio = document.createElement('p');
    vacio.className = 'sin-registro';
    vacio.textContent = 'Sin registros que coincidan.';
    detalleHistorial.appendChild(vacio);
  } else {
    const tablaHist = document.createElement('table');
    tablaHist.innerHTML = `
      <thead>
        <tr>
          <th>Placa</th><th>Conductor</th><th>Empresa</th><th>Andén</th>
          <th>Entrada</th><th>Salida</th><th>Duración</th>
        </tr>
      </thead>
    `;
    const tbodyHist = document.createElement('tbody');
    historialFiltrado.slice(0, 100).forEach((r) => {
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td class="unidad">${r.placa}</td>
        <td>${r.conductor}</td>
        <td>${r.empresa}</td>
        <td>${r.anden || '-'}</td>
        <td>${fechaCorta(r.entrada_en)} ${horaCorta(r.entrada_en)}</td>
        <td>${fechaCorta(r.salida_en)} ${horaCorta(r.salida_en)}</td>
        <td>${duracionPatio(r.entrada_en, r.salida_en)}</td>
      `;
      tbodyHist.appendChild(tr);
    });
    tablaHist.appendChild(tbodyHist);
    detalleHistorial.appendChild(tablaHist);
  }

  cont.appendChild(detalleHistorial);
  contenidoEl.appendChild(cont);
}

async function registrarSalidaPatio(id) {
  patioConfirmando = null;
  const res = await fetch(`/api/patio/${id}/salida`, { method: 'POST' });
  if (siSesionExpiro(res)) return;
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    alert(`Error: ${err.error || res.statusText}`);
    return;
  }
  await cargarPatio();
  dibujarContenido();
}

fechaInput.addEventListener('change', cargarRutas);

btnSync.addEventListener('click', async () => {
  btnSync.disabled = true;
  syncStatus.textContent = 'Sincronizando...';
  try {
    const res = await fetch('/api/samsara/sync', { method: 'POST' });
    if (siSesionExpiro(res)) return;
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Error desconocido');
    syncStatus.textContent = `OK: ${data.guardados}/${data.total} vehículos sincronizados.`;
  } catch (err) {
    syncStatus.textContent = `Error: ${err.message}`;
  } finally {
    btnSync.disabled = false;
  }
});

btnLogout.addEventListener('click', async () => {
  await fetch('/logout', { method: 'POST' });
  window.location.href = '/login';
});

cargarRutas();
