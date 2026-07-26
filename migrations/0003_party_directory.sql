CREATE TABLE parties (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  code varchar(64) NOT NULL CHECK (char_length(code) >= 1),
  display_name varchar(200) NOT NULL CHECK (char_length(display_name) >= 1),
  legal_name varchar(200),
  national_id varchar(64),
  registration_id varchar(64),
  phone varchar(64),
  email varchar(254),
  notes varchar(1000),
  state varchar(16) NOT NULL DEFAULT 'ACTIVE'
    CHECK (state IN ('ACTIVE', 'INACTIVE', 'MERGED')),
  merged_into_party_id uuid REFERENCES parties(id) ON DELETE RESTRICT,
  version integer NOT NULL DEFAULT 0 CHECK (version >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, code)
);

CREATE INDEX parties_organization_id_id_idx ON parties (organization_id, id);

CREATE TABLE party_kinds (
  party_id uuid NOT NULL REFERENCES parties(id) ON DELETE RESTRICT,
  party_kind varchar(32) NOT NULL CHECK (party_kind IN (
    'CUSTOMER', 'SUPPLIER', 'EMPLOYEE', 'SHAREHOLDER', 'REPRESENTATIVE',
    'BANK', 'COMPANY', 'ORGANIZATION', 'NATURAL_PERSON', 'LEGAL_PERSON', 'OTHER'
  )),
  PRIMARY KEY (party_id, party_kind)
);
