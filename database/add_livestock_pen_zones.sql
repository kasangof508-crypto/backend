-- Adds selectable livestock pens for databases created before these locations existed.
-- The original Dairy Pen footprint is divided into four placeholder zones; replace with surveyed boundaries before geofence use.
INSERT INTO zones (zone_name, zone_type, boundary)
SELECT additions.zone_name, 'pen', dairy.boundary
  FROM (
    SELECT 'Bull Pen' AS zone_name
    UNION ALL SELECT 'Goat Pen'
    UNION ALL SELECT 'Sheep Pen'
  ) AS additions
  JOIN zones AS dairy ON dairy.zone_name = 'Dairy Pen'
 WHERE NOT EXISTS (
   SELECT 1 FROM zones AS existing WHERE existing.zone_name = additions.zone_name
 );

UPDATE zones SET boundary = JSON_ARRAY(
  JSON_ARRAY(-1.2, 36.803), JSON_ARRAY(-1.2, 36.804),
  JSON_ARRAY(-1.19925, 36.804), JSON_ARRAY(-1.19925, 36.803)
) WHERE zone_name = 'Dairy Pen' AND zone_type = 'pen';

UPDATE zones SET boundary = JSON_ARRAY(
  JSON_ARRAY(-1.2, 36.804), JSON_ARRAY(-1.2, 36.805),
  JSON_ARRAY(-1.19925, 36.805), JSON_ARRAY(-1.19925, 36.804)
) WHERE zone_name = 'Bull Pen' AND zone_type = 'pen';

UPDATE zones SET boundary = JSON_ARRAY(
  JSON_ARRAY(-1.19925, 36.803), JSON_ARRAY(-1.19925, 36.804),
  JSON_ARRAY(-1.1985, 36.804), JSON_ARRAY(-1.1985, 36.803)
) WHERE zone_name = 'Goat Pen' AND zone_type = 'pen';

UPDATE zones SET boundary = JSON_ARRAY(
  JSON_ARRAY(-1.19925, 36.804), JSON_ARRAY(-1.19925, 36.805),
  JSON_ARRAY(-1.1985, 36.805), JSON_ARRAY(-1.1985, 36.804)
) WHERE zone_name = 'Sheep Pen' AND zone_type = 'pen';
