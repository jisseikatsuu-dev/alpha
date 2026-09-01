const tabsEl = document.getElementById('tabs');
const contenidoEl = document.getElementById('contenido');
const fechaInput = document.getElementById('fecha-input');
const btnSync = document.getElementById('btn-sync');
const syncStatus = document.getElementById('sync-status');
const btnLogout = document.getElementById('btn-logout');

let rutasData = {};
let rutaActiva = null;

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
