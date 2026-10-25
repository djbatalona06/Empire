-- Local demo data only:  npm run db:migrate:local && npx wrangler d1 execute DB --local --file seed/dev.sql
INSERT OR IGNORE INTO crews (id, name, lead_id) VALUES ('crew_north', 'SeaTac North', 'u_lead');
INSERT OR IGNORE INTO users (id, email, role, display_name, crew_id, locale) VALUES
  ('u_admin', 'admin@dealerdoor.test', 'admin', 'Avery Admin', NULL, 'en'),
  ('u_office', 'office@dealerdoor.test', 'office', 'Olive Office', NULL, 'en'),
  ('u_lead', 'lead@dealerdoor.test', 'lead', 'Leo Lead', 'crew_north', 'en'),
  ('u_rep1', 'rep1@dealerdoor.test', 'coworker', 'Rita Rep', 'crew_north', 'en'),
  ('u_rep2', 'rep2@dealerdoor.test', 'coworker', 'Sam Rep', 'crew_north', 'es');
INSERT OR IGNORE INTO properties (id, address, address_norm, zip, lat, lng, seatac_valid) VALUES
  ('p1', '4800 S 188th St, SeaTac, WA 98188', '4800 S 188TH ST SEATAC WA 98188', '98188', 47.4370, -122.2770, 1),
  ('p2', '18000 International Blvd, SeaTac, WA 98188', '18000 INTERNATIONAL BLVD SEATAC WA 98188', '98188', 47.4410, -122.2960, 1),
  ('p3', '3200 S 200th St, SeaTac, WA 98198', '3200 S 200TH ST SEATAC WA 98198', '98198', 47.4235, -122.2890, 1);
UPDATE properties SET do_not_knock = 1, dnk_reason = 'Resident request' WHERE id = 'p3';
INSERT OR IGNORE INTO routes (id, name, coworker_id, assigned_by, route_date, permit_ref) VALUES ('r1', 'Demo route', 'u_rep1', 'u_lead', date('now'), 'SEATAC-PERMIT-PENDING');
INSERT OR IGNORE INTO route_stops (id, route_id, property_id, sort_order) VALUES ('s1', 'r1', 'p1', 0), ('s2', 'r1', 'p2', 1);
