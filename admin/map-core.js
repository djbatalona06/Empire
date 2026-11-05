'use strict';
// Shared map code for the admin console (Map view, order mini-map) and the phone map page.
// Needs Leaflet and Leaflet.markercluster loaded first. Text from the server is shown as text, never as HTML.

const DealerMap = (() => {
  // One place to change the map tiles. The public OpenStreetMap server is fine for a pilot.
  // For heavier use, switch to a hosted tile provider (see docs/07-LAUNCH-CHECKLIST.md).
  const TILE_URL = 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';
  const ATTRIBUTION = '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors';
  const SEATAC_CENTER = [47.4435, -122.285];
  const REFRESH_DELAY_MS = 300;

  const LEAD_COLORS = { interested: '#0b6bcb', new: '#0b6bcb', appointment: '#9a6700', not_serviceable: '#b42318', closed: '#5f6b7a' };
  const SALE_COLORS = { submitted: '#9a6700', scheduled: '#0b6bcb', installed: '#0b6bcb', activated: '#1a7f37', closed: '#5f6b7a' };
  const LAYER_LABELS = { leads: 'Leads', sales: 'Sales', dnk: 'Do-not-knock', checkins: 'Door knocks' };
  const FIT_LIMIT = 19; // the closest zoom the tiles go to
  const FOCUS_ZOOM = 18;

  // ---- The full map ---------------------------------------------------------

  /**
   * Draws the map into `host` and keeps it filled with the pins for whatever part of the map is on screen.
   * options:
   *   fetchPoints(queryString) -> Promise of the /map/points answer
   *   fetchArea()              -> Promise of the service-area list (optional)
   *   filters()                -> { status, from, to } read from the page's form (optional)
   *   onOpen(kind, id)         -> called from a popup's "Open" button (optional)
   *   onNote(text)             -> told when to show or clear a notice such as "list was cut short" (optional)
   *   locate                   -> true adds a "Near me" button (phone page)
   */
  function create(host, options) {
    const map = L.map(host).setView(SEATAC_CENTER, 13);
    L.tileLayer(TILE_URL, { maxZoom: FIT_LIMIT, attribution: ATTRIBUTION }).addTo(map);

    const cluster = () => L.markerClusterGroup({ showCoverageOnHover: false, maxClusterRadius: 45 });
    const groups = { leads: cluster(), sales: cluster(), dnk: L.layerGroup(), checkins: cluster() };
    for (const name of ['leads', 'sales', 'dnk']) groups[name].addTo(map);
    L.control.layers(null, Object.fromEntries(Object.entries(groups).map(([k, g]) => [LAYER_LABELS[k], g])), { collapsed: window.innerWidth < 700 }).addTo(map);
    addLegend(map);
    if (options.fetchArea) drawServiceArea(map, options.fetchArea);
    if (options.locate) addLocateButton(map, options.onNote);

    const visibleLayers = () => Object.keys(groups).filter((name) => map.hasLayer(groups[name]));
    let latest = 0;
    let timer;
    let pendingForce = false;
    let loaded = null; // what is on the map now: { area, key, cut }

    // `force` reloads even if the map has not left the area we already loaded. Panning alone does not force:
    // opening a pin's popup nudges the map, and reloading then would rebuild the pins and close that popup.
    async function refresh(force) {
      const mine = ++latest;
      const layers = visibleLayers();
      for (const name of Object.keys(groups)) if (!layers.includes(name)) groups[name].clearLayers();
      if (!layers.length) {
        loaded = null;
        return;
      }

      const filters = cleaned(options.filters?.());
      const key = JSON.stringify([layers, filters]);
      if (!force && loaded && loaded.key === key && !loaded.cut && loaded.area.contains(map.getBounds())) return;

      const area = map.getBounds().pad(0.25);
      const params = new URLSearchParams({ layers: layers.join(','), bbox: boxText(area), ...filters });
      const data = await options.fetchPoints(params.toString());
      if (mine !== latest) return; // a newer request is already on its way

      for (const name of layers) {
        const group = groups[name];
        const pins = (data[name] ?? []).map((row) => marker(name, row, options.onOpen));
        group.clearLayers();
        // Cluster groups take a whole batch at once (much faster); the plain do-not-knock group takes one by one.
        if (group.addLayers) group.addLayers(pins);
        else for (const pin of pins) group.addLayer(pin);
      }
      const cut = layers.filter((name) => data.truncated?.[name]).map((name) => LAYER_LABELS[name]);
      loaded = { area, key, cut: cut.length > 0 };
      options.onNote?.(cut.length ? `Showing the newest pins for ${cut.join(', ')}. Zoom in or narrow the dates to see the rest.` : '');
    }

    const soon = (force) => {
      pendingForce ||= force === true;
      clearTimeout(timer);
      timer = setTimeout(() => {
        const wanted = pendingForce;
        pendingForce = false;
        refresh(wanted).catch((e) => options.onNote?.(e.message));
      }, REFRESH_DELAY_MS);
    };
    map.on('moveend', () => soon(false));
    map.on('overlayadd overlayremove', () => soon(true));
    soon(true);

    return {
      map,
      refresh: () => soon(true),
      invalidate: () => map.invalidateSize(),
      /** Zoom right in on one place, close enough to tell neighbouring pins apart. */
      focus: (lat, lng) => map.setView([lat, lng], FOCUS_ZOOM),
    };
  }

  // ---- A small map for one place (order dialog) ------------------------------

  /** One pin on a small map. Call show(lat, lng) whenever the place changes; hides itself when there is no position. */
  function mini(host) {
    let map;
    let pin;
    return {
      show(lat, lng, label) {
        host.hidden = lat == null || lng == null;
        if (host.hidden) return;
        if (!map) {
          map = L.map(host, { scrollWheelZoom: false });
          L.tileLayer(TILE_URL, { maxZoom: FIT_LIMIT, attribution: ATTRIBUTION }).addTo(map);
        }
        map.setView([lat, lng], 17);
        pin?.remove();
        pin = L.marker([lat, lng], { title: label ?? 'Location' }).addTo(map);
        // A map inside a dialog that just opened measures itself at zero size until the dialog is visible.
        setTimeout(() => map.invalidateSize(), 50);
      },
    };
  }

  // ---- Pins ------------------------------------------------------------------

  function marker(layer, row, onOpen) {
    const m = L.marker([row.lat, row.lng], { icon: iconFor(layer, row), title: row.customer_name || row.address || LAYER_LABELS[layer] });
    m.bindPopup(() => popup(layer, row, onOpen), { minWidth: 200 });
    return m;
  }

  function iconFor(layer, row) {
    const size = layer === 'sales' ? 26 : layer === 'checkins' ? 12 : 20;
    const color = layer === 'sales' ? SALE_COLORS[row.status] : LEAD_COLORS[row.status];
    const dot = document.createElement('span');
    dot.style.setProperty('--c', color ?? '#5f6b7a');
    if (layer === 'dnk') dot.textContent = '✋';
    const html = dot.outerHTML; // built from our own colour table and a fixed symbol: no server text in here
    return L.divIcon({ className: `dd-pin dd-pin-${layer}`, html, iconSize: [size, size], iconAnchor: [size / 2, size / 2], popupAnchor: [0, -size / 2] });
  }

  function popup(layer, row, onOpen) {
    const box = document.createElement('div');
    box.className = 'dd-popup';
    const line = (text, className) => text && box.append(Object.assign(document.createElement('div'), { className: className ?? '', textContent: text }));

    if (layer === 'dnk') {
      line('Do not knock', 'dd-popup-title');
      line(row.address);
    } else if (layer === 'checkins') {
      line(`Door knock: ${words(row.outcome)}`, 'dd-popup-title');
      line(row.address);
      line(`${row.coworker_name ?? ''} · ${when(row.created_at)}`.replace(/^ · /, ''));
    } else {
      line(row.customer_name || 'Customer', 'dd-popup-title');
      line(row.address);
      line(`${layer === 'sales' ? 'Sale' : 'Lead'} · ${words(row.status)}`);
      line(`${row.coworker_name ?? 'No rep'} · ${when(row.created_at)}`);
      if (layer === 'sales' && onOpen) {
        const open = Object.assign(document.createElement('button'), { type: 'button', className: 'small', textContent: 'Open order' });
        open.onclick = () => onOpen('sales', row.id);
        box.append(open);
      }
    }
    return box;
  }

  // ---- Map furniture ---------------------------------------------------------

  function addLegend(map) {
    const Legend = L.Control.extend({
      onAdd() {
        const box = L.DomUtil.create('div', 'dd-legend');
        const item = (layer, text) => {
          const row = document.createElement('div');
          const sample = document.createElement('span');
          sample.className = `dd-pin dd-pin-${layer} dd-legend-sample`;
          sample.append(Object.assign(document.createElement('span'), { textContent: layer === 'dnk' ? '✋' : '' }));
          sample.firstChild.style.setProperty('--c', layer === 'sales' ? SALE_COLORS.activated : layer === 'dnk' ? '#b42318' : LEAD_COLORS.interested);
          row.append(sample, text);
          box.append(row);
        };
        item('leads', 'Lead');
        item('sales', 'Sale');
        item('dnk', 'Do not knock');
        L.DomEvent.disableClickPropagation(box);
        return box;
      },
    });
    new Legend({ position: 'bottomleft' }).addTo(map);
  }

  async function drawServiceArea(map, fetchArea) {
    try {
      for (const area of await fetchArea()) {
        L.geoJSON(area.geojson, { style: { color: '#0b6bcb', weight: 2, fill: false, dashArray: '6 4' }, interactive: false }).addTo(map);
      }
    } catch {
      // The outline is a nice-to-have; the pins still work without it.
    }
  }

  function addLocateButton(map, onNote) {
    const Locate = L.Control.extend({
      onAdd() {
        const button = L.DomUtil.create('button', 'dd-locate');
        button.type = 'button';
        button.textContent = 'Near me';
        button.setAttribute('aria-label', 'Show my location on the map');
        L.DomEvent.disableClickPropagation(button);
        button.onclick = () => map.locate({ setView: true, maxZoom: 17 });
        return button;
      },
    });
    new Locate({ position: 'topleft' }).addTo(map);
    let here;
    map.on('locationfound', (e) => {
      here?.remove();
      here = L.circleMarker(e.latlng, { radius: 8, color: '#fff', weight: 3, fillColor: '#0b6bcb', fillOpacity: 1 }).addTo(map);
      onNote?.('');
    });
    map.on('locationerror', (e) => onNote?.(`Could not get your location: ${e.message}`));
  }

  // ---- Small helpers ---------------------------------------------------------

  /** An area as "minLng,minLat,maxLng,maxLat", kept inside the world. */
  function boxText(b) {
    const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));
    return [clamp(b.getWest(), -180, 180), clamp(b.getSouth(), -90, 90), clamp(b.getEast(), -180, 180), clamp(b.getNorth(), -90, 90)].map((n) => n.toFixed(5)).join(',');
  }

  const cleaned = (obj = {}) => Object.fromEntries(Object.entries(obj).filter(([, v]) => v));
  const words = (text) => String(text ?? '').replaceAll('_', ' ');
  const when = (iso) => (iso ? new Date(iso.replace(' ', 'T') + (iso.length === 19 ? 'Z' : '')).toLocaleDateString() : '');

  return { create, mini };
})();
