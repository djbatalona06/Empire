# Vendored map libraries

Copied unchanged from the npm packages so the admin console needs no build step and no CDN.

| Library                | Version | Licence | Source                                  |
|------------------------|---------|---------|-----------------------------------------|
| Leaflet                | 1.9.4   | BSD-2   | `npm pack leaflet@1.9.4`                |
| Leaflet.markercluster  | 1.5.3   | MIT     | `npm pack leaflet.markercluster@1.5.3`  |

Integrity of `leaflet/leaflet.js` and `leaflet/leaflet.css` (same values Leaflet publishes on its download page):

```
leaflet.js   sha256-20nQCchB9co0qIjJZRGuk2/Z9VM+kNiyxNV1lvTlZBo=
leaflet.css  sha256-p4NxAoJBhIIN+hmNHrzRCf9tD/miZyoHS5obTRR9BMY=
```

Check a file yourself:

```bash
echo "sha256-$(openssl dgst -sha256 -binary admin/vendor/leaflet/leaflet.js | openssl base64 -A)"
```

To upgrade, pack the new version, copy the same files, and update this table.
