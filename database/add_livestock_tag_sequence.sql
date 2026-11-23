-- Apply once to an existing SAFM-SYS database to generate new livestock tags sequentially.
CREATE TABLE livestock_tag_sequence (
  sequence_id   TINYINT UNSIGNED PRIMARY KEY,
  prefix        VARCHAR(23) NOT NULL,
  next_number   VARCHAR(24) NOT NULL,
  padding       TINYINT UNSIGNED NOT NULL,
  initialized   BOOLEAN NOT NULL DEFAULT FALSE
) ENGINE=InnoDB;

INSERT INTO livestock_tag_sequence (sequence_id, prefix, next_number, padding, initialized)
VALUES (1, 'COW-', '1', 4, FALSE);
