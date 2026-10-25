-- Reference data every environment needs. Demo users live in seed/dev.sql (local only).

INSERT INTO settings (key, value) VALUES
  ('solicitation_permit_ref', 'SEATAC-PERMIT-PENDING'),
  ('default_payment_term_days', '30'),
  ('active_consent_version', 'v1'),
  ('geofence_meters', '100'),
  ('stale_lead_days', '30');

-- PLACEHOLDER consent language. Must be replaced by counsel-approved text before launch;
-- bump the version (v2…) instead of editing v1 so old consent records stay accurate.
INSERT INTO consent_texts (version, kind, locale, body) VALUES
  ('v1', 'tcpa', 'en', 'By checking this box, I agree that the dealer may call or text me at the number provided, including by automated means, about my service order. Consent is not a condition of purchase. Message and data rates may apply. Reply STOP to opt out.'),
  ('v1', 'tcpa', 'es', 'Al marcar esta casilla, acepto que el distribuidor me llame o envíe mensajes de texto al número proporcionado, incluso por medios automatizados, sobre mi pedido de servicio. El consentimiento no es una condición de compra. Pueden aplicarse tarifas de mensajes y datos. Responda STOP para cancelar.'),
  ('v1', 'd2d_disclosure', 'en', 'I understand this visit is from an independent dealer authorized to sell AT&T services, not AT&T itself. I may cancel within three business days as provided by law. AT&T service charges are billed separately by AT&T.'),
  ('v1', 'd2d_disclosure', 'es', 'Entiendo que esta visita es de un distribuidor independiente autorizado para vender servicios de AT&T, no de AT&T. Puedo cancelar dentro de tres días hábiles según lo establece la ley. Los cargos del servicio de AT&T los factura AT&T por separado.');

-- PLACEHOLDER catalog. Office replaces names/prices with the current dealer rate card.
INSERT INTO catalog_items (id, sku, kind, name, name_es, speed_mbps, monthly_price_cents, promo_price_cents, promo_months, contract_months, eligibility_notes, required_tech, commission_cents) VALUES
  ('cat_fiber_300',  'FIBER-300',  'internet', 'Fiber Internet 300',  'Internet de fibra 300',  300,  5500, NULL, NULL, 0, 'Fiber-served addresses only', 'fiber', 4000),
  ('cat_fiber_1g',   'FIBER-1G',   'internet', 'Fiber Internet 1 Gig', 'Internet de fibra 1 Gig', 1000, 8000, NULL, NULL, 0, 'Fiber-served addresses only', 'fiber', 6000),
  ('cat_air',        'AIR',        'internet', 'Fixed Wireless Internet', 'Internet inalámbrico fijo', 100, 6000, 4700, 12, 0, 'Where fiber is unavailable', 'internet_air', 2500),
  ('cat_tv_stream',  'TV-STREAM',  'tv',       'Streaming TV Package', 'Paquete de TV por streaming', NULL, 6500, NULL, NULL, 0, 'Requires internet service', NULL, 2000),
  ('cat_bundle_1g',  'BUNDLE-1G-TV','bundle',  'Fiber 1 Gig + Streaming TV', 'Fibra 1 Gig + TV por streaming', 1000, 13500, 12000, 12, 12, 'Fiber-served addresses only', 'fiber', 9000),
  ('cat_mesh',       'ADDON-MESH', 'addon',    'Whole-home Wi-Fi extender', 'Extensor Wi-Fi para todo el hogar', NULL, 1000, NULL, NULL, 0, NULL, NULL, 500);

-- APPROXIMATE SeaTac city outline (lng, lat). Replace with the official King County GIS
-- city-limits polygon before the pilot; admins can also update it via /v1/admin/service-area.
INSERT INTO service_area (id, name, geojson) VALUES ('seatac', 'SeaTac',
  '{"type":"Polygon","coordinates":[[[-122.3245,47.4895],[-122.2900,47.4895],[-122.2620,47.4880],[-122.2600,47.4500],[-122.2640,47.4200],[-122.2850,47.4100],[-122.3100,47.4100],[-122.3245,47.4250],[-122.3245,47.4895]]]}');

-- Starter coverage rows for SeaTac ZIPs so serviceability works on day one.
INSERT INTO coverage (id, zip, street_norm, tech, max_speed_mbps) VALUES
  ('cov_98188_air', '98188', NULL, 'internet_air', 100),
  ('cov_98198_air', '98198', NULL, 'internet_air', 100),
  ('cov_98158_air', '98158', NULL, 'internet_air', 100),
  ('cov_98168_air', '98168', NULL, 'internet_air', 100);
