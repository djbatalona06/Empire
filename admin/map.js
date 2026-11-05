'use strict';
// Phone map page. Sign-in comes from auth.js, the map from map-core.js.
// The server decides what each person may see: a rep gets their own leads and sales, a team lead their crew.

bootAuth({
  accepts: (m) => (m.role === 'customer' ? 'The map is for the sales team. Use the DealerDoor app.' : null),
  ready: showMap,
});

function showMap() {
  $('#me-name').textContent = me.display_name ?? me.email;
  $('#logout').onclick = () => window.signOut();
  $('#app').hidden = false;

  DealerMap.create($('#leaflet-map'), {
    fetchPoints: (query) => api(`/map/points?${query}`),
    fetchArea: () => api('/service-area'),
    onNote: (text) => { $('#map-note').textContent = text; },
    locate: true,
  });
}
