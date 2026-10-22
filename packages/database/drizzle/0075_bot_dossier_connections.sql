ALTER TABLE manual_dossier_connections
  DROP CONSTRAINT manual_dossier_connections_origin_check,
  ADD CONSTRAINT manual_dossier_connections_origin_check
    CHECK (origin IN ('dossier', 'applicant_sheet', 'bot'));
